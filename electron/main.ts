// Electron-Hauptprozess: Fenster, Datenbank, Dateien und Claude-Aufrufe.
// Die Oberfläche greift nur über die IPC-Kanäle unten darauf zu (siehe preload.ts).

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { basename, dirname, maxPoints, stem } from '../shared/logic'
import type { Api, Config, GenerateRequest, Grading, Progress, ScanInfo, Source, SourceMode } from '../shared/types'
import { AIError, checkKey, extractExam, generateQuestions, gradeAnswer, makeClient } from './ai'
import { CACHE_DIR, CONFIG_FILE, DB_FILE, ignored, loadConfig, saveConfig } from './config'
import { apiKey, clearKey, keyringAvailable, keySource, saveKey } from './secret'
import { Database, UserError } from './db'
import { readImport, summary, writeExport } from './transfer'
import { IMAGE_SUFFIXES, scan, type ScanResult } from './vault'

const here = path.dirname(fileURLToPath(import.meta.url))

// Chromium-Daten (Cache, Fensterzustand) nicht in ~/.config/pruefungstrainer neben die Einstellungen legen
app.setPath('userData', path.join(CACHE_DIR, 'electron'))
app.setName('Prüfungstrainer')
// Den Schlüsselbund (Secret Service) auch ausserhalb von GNOME nutzen; Chromium erkennt ihn sonst
// z. B. unter Hyprland nicht und würde gespeicherte Keys nur zum Schein verschlüsseln.
if (!app.commandLine.hasSwitch('password-store') && !/KDE/i.test(process.env.XDG_CURRENT_DESKTOP ?? '')) {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
}

let win: BrowserWindow | null = null
let db: Database
let cfg: Config = loadConfig()
let lastScan: ScanResult | null = null
let cancelGenerate = false

function progress(p: Progress): void {
  win?.webContents.send('progress', p)
}

function startDir(): string {
  return cfg.last_dir || os.homedir()
}

function rememberDir(dir: string): void {
  cfg.last_dir = dir
  saveConfig(cfg)
}

// --- Einlesen und Generieren ------------------------------------------

/** Dateien einer Quelle für Entfernen/Verschieben – dazu die Ordner ihrer Screenshot-Altklausuren,
 *  denn deren Fragen hängen am Ordner. */
function sourceFilesWithGroups(src: Source): string[] {
  const files = lastScan?.files[src.id]?.length ? lastScan.files[src.id] : src.kind === 'file' ? [src.path] : []
  if (src.mode !== 'klausur') return files
  const dirs = files.filter((f) => IMAGE_SUFFIXES.has(path.extname(f).toLowerCase())).map((f) => path.dirname(f))
  return [...new Set([...files, ...dirs])]
}

async function runScan(): Promise<ScanInfo> {
  progress({ job: 'scan', done: 0, total: 0, msg: '' })
  const result = await scan(db.sources(), ignored(cfg))
  lastScan = result
  const newNoteQuestions = db.upsertNoteQuestions(result.noteQuestions)
  return {
    files: result.files,
    sections: result.sections.map(({ text: _t, pages: _p, imageFiles, ...info }) => (imageFiles && info.kind === 'klausur' ? { ...info, imageCount: imageFiles.length } : info)),
    errors: result.errors,
    newNoteQuestions,
  }
}

async function runGenerate(req: GenerateRequest): Promise<number> {
  if (!lastScan) throw new UserError('Die Quellen werden noch eingelesen.')
  const sections = lastScan.sections
  let targets
  if (req.scope === 'selection') {
    const keys = new Set(req.keys)
    targets = sections.filter((s) => s.subject_id === req.subjectId && keys.has(s.key))
  } else {
    const done = new Map<number, Record<string, string>>()
    targets = sections.filter((s) => {
      if (req.scope === 'subject' && s.subject_id !== req.subjectId) return false
      if (!done.has(s.subject_id)) done.set(s.subject_id, db.generatedHashes(s.subject_id))
      return done.get(s.subject_id)![s.key] !== s.hash
    })
  }
  if (!targets.length) {
    throw new UserError('Keine Abschnitte zu bearbeiten. Füge Quellen hinzu oder wähle Abschnitte aus.')
  }
  if (!req.kinds.length && targets.some((s) => s.kind !== 'klausur')) {
    throw new UserError('Bitte mindestens einen Fragetyp wählen.')
  }
  const client = makeClient(apiKey())
  cfg.questions_per_section = req.count
  saveConfig(cfg)
  const model = cfg.model

  cancelGenerate = false
  let total = 0
  for (const [i, s] of targets.entries()) {
    if (cancelGenerate) break
    progress({ job: 'generate', done: i, total: targets.length, msg: `${basename(s.path)} (${s.label}) …` })
    let exam = null
    let qs
    try {
      if (s.kind === 'klausur') {
        exam = await extractExam(client, model, s)
        qs = exam.questions
      } else {
        qs = await generateQuestions(client, model, s, req.count, req.kinds)
      }
    } catch (e) {
      if (!(e instanceof AIError)) throw e
      progress({ job: 'generate', done: i, total: targets.length, msg: `  Fehler: ${e.message}` })
      if (e.fatal) break
      continue
    }
    // Bereits übernommene Klausuraufgaben (gleiche Nummer) werden aktualisiert
    const fresh = qs.filter((q) => (exam ? db.upsertExamQuestion(q) : db.saveQuestion(q))).length
    if (exam) db.syncExamSet(s.path, qs.map((q) => q.ext_key!), exam.minutes)
    db.markGenerated(s.subject_id, s.key, s.hash)
    total += fresh
    let msg: string
    if (exam) {
      msg = `  ${qs.length} Aufgaben erkannt (${qs.reduce((sum, q) => sum + maxPoints(q), 0)} P.)`
      if (fresh < qs.length) msg += `, davon ${qs.length - fresh} aktualisiert`
      if (exam.aiSolved) msg += `, ${exam.aiSolved} mit KI-Lösung (bitte prüfen)`
      if (exam.unsolved) msg += `, ${exam.unsolved} ohne Lösung`
      if (exam.expected > 0 && qs.length < exam.expected) {
        msg += ` – Achtung: im Text stehen offenbar ${exam.expected} Aufgaben. Mit „Auswahl (neu) verarbeiten“ erneut versuchen.`
      }
      msg += ` – Übungssatz „${stem(s.path)}“`
    } else {
      msg = `  ${fresh} Fragen erzeugt`
    }
    progress({ job: 'generate', done: i + 1, total: targets.length, msg })
  }
  return total
}

async function runGrade(items: { questionId: number; answer: string }[]) {
  const client = makeClient(apiKey())
  const results: (Grading | null)[] = []
  const errors = new Set<string>()
  for (const [i, item] of items.entries()) {
    progress({ job: 'grade', done: i, total: items.length, msg: '' })
    const q = db.question(item.questionId)
    if (!q) {
      results.push(null)
      continue
    }
    try {
      results.push(await gradeAnswer(client, cfg.model, q, item.answer))
    } catch (e) {
      if (!(e instanceof AIError)) throw e
      errors.add(e.message)
      results.push(null)
    }
  }
  progress({ job: 'grade', done: items.length, total: items.length, msg: '' })
  return { results, errors: [...errors].sort() }
}

// --- IPC --------------------------------------------------------------

type Handlers = { [K in keyof Omit<Api, 'onProgress'>]: (...args: Parameters<Api[K]>) => Awaited<ReturnType<Api[K]>> | ReturnType<Api[K]> }

const handlers: Handlers = {
  info: () => {
    const source = keySource()
    return { configFile: CONFIG_FILE, dbFile: DB_FILE, hasApiKey: source !== null, keySource: source, keyring: keyringAvailable() }
  },
  setApiKey: async (key) => {
    const k = key.trim()
    if (!/^sk-ant-/.test(k)) throw new UserError('Das sieht nicht nach einem Anthropic-API-Key aus (beginnt mit „sk-ant-“).')
    const warning = await checkKey(k, cfg.model)
    saveKey(k)
    return warning
  },
  clearApiKey: () => clearKey(),
  getConfig: () => cfg,
  saveConfig: (patch) => {
    cfg = { ...cfg, ...patch }
    saveConfig(cfg)
    return cfg
  },

  subjects: () => db.subjects(),
  addSubject: (name) => db.addSubject(name),
  renameSubject: (id, name) => db.renameSubject(id, name),
  deleteSubject: (id) => db.deleteSubject(id),
  mergeSubjects: (a, b) => db.mergeSubjects(a, b),
  questionCounts: () => db.questionCounts(),

  sources: (subjectId) => db.sources(subjectId),
  pickSources: async (subjectId, what) => {
    if (!win) return false
    if (what === 'folder') {
      const r = await dialog.showOpenDialog(win, { title: 'Ordner hinzufügen', defaultPath: startDir(), properties: ['openDirectory'] })
      if (r.canceled || !r.filePaths.length) return false
      const folder = fs.realpathSync(r.filePaths[0])
      db.addSource(subjectId, folder, 'dir')
      rememberDir(dirname(folder))
      return true
    }
    const exams = what === 'exams'
    const r = await dialog.showOpenDialog(win, {
      title: exams ? 'Altklausuren hinzufügen' : 'Dateien hinzufügen',
      defaultPath: startDir(),
      properties: ['openFile', 'multiSelections'],
      filters: exams
        ? [{ name: 'Altklausuren (PDF, Text, Screenshots)', extensions: ['pdf', 'txt', 'md', 'png', 'jpg', 'jpeg', 'webp', 'gif'] }]
        : [{ name: 'Notizen, Texte, PDFs und Bilder', extensions: ['md', 'txt', 'pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    })
    if (r.canceled || !r.filePaths.length) return false
    for (const f of r.filePaths) db.addSource(subjectId, fs.realpathSync(f), 'file', exams ? 'klausur' : 'lernstoff')
    rememberDir(dirname(r.filePaths[0]))
    return true
  },
  setSourceMode: (id, mode: SourceMode) => db.setSourceMode(id, mode),
  removeSources: (ids, deleteQuestions) => {
    const all = new Map(db.sources().map((s) => [s.id, s]))
    for (const id of ids) {
      const src = all.get(id)
      if (!src) continue
      const files = sourceFilesWithGroups(src)
      db.removeSource(src, files, deleteQuestions)
    }
  },
  moveSources: (ids, target) => {
    const all = new Map(db.sources().map((s) => [s.id, s]))
    for (const id of ids) {
      const src = all.get(id)
      if (!src) continue
      const files = sourceFilesWithGroups(src)
      db.moveSource(src, files, target)
    }
  },
  scan: () => runScan(),
  generatedHashes: (subjectId) => db.generatedHashes(subjectId),
  generate: (req) => runGenerate(req),
  cancelGenerate: () => {
    cancelGenerate = true
  },

  questions: () => db.questions(),
  saveQuestion: (q) => {
    db.saveQuestion(q)
    return db.question(q.id!)!
  },
  deleteQuestions: (ids) => db.deleteQuestions(ids),
  moveQuestions: (ids, target) => db.moveQuestions(ids, target),
  setApproved: (ids, approved) => db.setApproved(ids, approved),
  openSource: async (file) => {
    if (!file) return
    if (file.toLowerCase().endsWith('.md')) {
      try {
        await shell.openExternal(`obsidian://open?path=${encodeURIComponent(file)}`)
        return
      } catch {
        // kein Obsidian installiert
      }
    }
    await shell.openPath(file)
  },

  practiceSets: () => db.practiceSets(),
  setSubjects: () => db.setSubjects(),
  addPracticeSet: (name) => db.addPracticeSet(name),
  renamePracticeSet: (id, name) => db.renamePracticeSet(id, name),
  setPracticeMinutes: (id, minutes) => db.setPracticeMinutes(id, minutes),
  deletePracticeSet: (id) => db.deletePracticeSet(id),
  setQuestionIds: (setId) => db.setQuestionIds(setId),
  addToSet: (setId, ids) => db.addToSet(setId, ids),
  reorderSet: (setId, ids) => db.reorderSet(setId, ids),

  successRates: () => db.successRates(),
  subjectStats: () => db.subjectStats(),
  recordAttempt: (qid, points, max) => db.recordAttempt(qid, points, max),
  updateAttempt: (id, points) => db.updateAttempt(id, points),
  grade: (items) => runGrade(items),

  exportData: async (subjectIds) => {
    if (!win) return null
    const day = new Date().toISOString().slice(0, 10)
    const r = await dialog.showSaveDialog(win, {
      title: 'Exportieren',
      defaultPath: path.join(startDir(), `pruefungstrainer-${day}.json`),
      filters: [{ name: 'Export', extensions: ['json'] }],
    })
    if (r.canceled || !r.filePath) return null
    const file = r.filePath.toLowerCase().endsWith('.json') ? r.filePath : `${r.filePath}.json`
    try {
      const data = writeExport(db, new Set(subjectIds), file)
      return { file, subjects: data.subjects.length, questions: data.questions.length, sets: data.sets.length }
    } catch (e) {
      throw new UserError(`Datei konnte nicht geschrieben werden: ${e instanceof Error ? e.message : e}`)
    }
  },
  importData: async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      title: 'Importieren', defaultPath: startDir(), properties: ['openFile'],
      filters: [{ name: 'Export', extensions: ['json'] }],
    })
    if (r.canceled || !r.filePaths.length) return null
    return `Import abgeschlossen: ${summary(readImport(db, r.filePaths[0]))}`
  },
}

function registerIpc(): void {
  for (const [name, fn] of Object.entries(handlers)) {
    ipcMain.handle(`api:${name}`, async (_e, ...args: unknown[]) => {
      try {
        return { ok: true, value: await (fn as (...a: unknown[]) => unknown)(...args) }
      } catch (e) {
        // Erwartete Fehler zeigt die Oberfläche als Meldung, alles andere zusätzlich im Log
        if (!(e instanceof UserError) && !(e instanceof AIError)) console.error(`api:${name}`, e)
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    })
  }
}

// --- Fenster ----------------------------------------------------------

function createWindow(): void {
  win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'Prüfungstrainer',
    backgroundColor: '#f7f7f5',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  // Links aus Fragen und Lösungen im Browser öffnen, nie im App-Fenster
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url === win?.webContents.getURL()) return
    e.preventDefault()
    if (/^https?:/.test(url) && !url.startsWith(process.env.VITE_DEV_SERVER_URL ?? '\0')) void shell.openExternal(url)
  })
  win.on('closed', () => {
    win = null
  })
  if (process.env.VITE_DEV_SERVER_URL) void win.loadURL(process.env.VITE_DEV_SERVER_URL)
  else void win.loadFile(path.join(here, '..', 'dist', 'index.html'))
}

app.whenReady().then(() => {
  try {
    db = new Database(DB_FILE)
    db.backup()
  } catch (e) {
    dialog.showErrorBox('Prüfungstrainer', `Die Datenbank ${DB_FILE} konnte nicht geöffnet werden:\n\n${e instanceof Error ? e.message : e}`)
    app.quit()
    return
  }
  Menu.setApplicationMenu(null)
  registerIpc()
  createWindow()
})

app.on('window-all-closed', () => {
  db?.close()
  app.quit()
})
