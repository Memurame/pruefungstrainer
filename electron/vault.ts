// Liest die Quellen eines Fachs: teilt Markdown, Text, PDFs und Screenshots in Abschnitte auf und findet manuell
// notierte Fragen. Die Dateien werden nie verändert.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { emptyQuestion, stem } from '../shared/logic'
import type { Question, SectionInfo, Source } from '../shared/types'
import { noteKey } from './db'
import { pageCount } from './pdf'

const MD_MAX_CHARS = 12_000 // Größe eines Markdown-Abschnitts für die KI
const MD_MIN_CHARS = 300 // kürzere Notizen lohnen keine Fragen
const PDF_PAGES = 15 // Seiten pro PDF-Abschnitt
const EXAM_PAGES = 100 // Altklausuren am Stück; mehr Seiten nimmt die API pro PDF nicht an
const TEXT_SUFFIXES = new Set(['.md', '.txt']) // Notizen und reiner Text
export const IMAGE_SUFFIXES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']) // Screenshots
const SUFFIXES = new Set([...TEXT_SUFFIXES, ...IMAGE_SUFFIXES, '.pdf'])
const EXAM_IMAGES = 15 // Screenshots pro Anfrage an die KI

const HEADING = /^(#{1,3})\s+(.+?)\s*#*$/
const FENCE = /^\s*(```|~~~)/
// „Frage?::Antwort“ – das Fragezeichen grenzt das Format von Dataview-Feldern (key:: value) ab
const INLINE_QA = /^\s*(?:[-*]\s+)?(.+\?)\s*::\s*(.+)$/
const CALLOUT_START = /^>\s*\[!frage\][-+]?\s*(.*)$/i

export interface Section extends SectionInfo {
  text: string // nur Markdown
  pages: [number, number] // nur PDF, 0-basiert, Ende exklusiv
  imageFiles?: string[] // nur Screenshots, in Lesereihenfolge
}

export interface ScanResult {
  files: Record<number, string[]>
  sections: Section[]
  noteQuestions: Question[]
  errors: string[]
}

const splitLines = (s: string) => s.replace(/\n$/, '').split('\n')
const sha = (data: string | Uint8Array) => crypto.createHash('sha256').update(data).digest('hex')

function sourceFiles(source: Source, ignored: Set<string>): string[] {
  const root = source.path
  if (source.kind === 'file') {
    try {
      return fs.statSync(root).isFile() ? [root] : []
    } catch {
      return []
    }
  }
  const files: string[] = []
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!ignored.has(e.name) && !e.name.startsWith('.')) walk(full)
      } else if (SUFFIXES.has(path.extname(e.name).toLowerCase())) {
        try {
          if (fs.statSync(full).isFile()) files.push(full)
        } catch {
          // kaputter Link
        }
      }
    }
  }
  walk(root)
  return files.sort()
}

export async function scan(sources: Source[], ignored: Set<string>): Promise<ScanResult> {
  const result: ScanResult = { files: {}, sections: [], noteQuestions: [], errors: [] }
  const seen = new Set<string>() // Datei doppelt im selben Fach (Ordner + Einzeldatei)
  // Screenshots einer Altklausur: je Fach und Ordner gesammelt, da Frage und Lösung oft auf
  // verschiedenen Bildern stehen
  const examImages = new Map<string, { subjectId: number; dir: string; files: string[] }>()
  // Altklausuren zuerst, damit eine Klausur im Lernstoff-Ordner als Klausur gilt
  const ordered = [...sources].sort((a, b) => Number(a.mode !== 'klausur') - Number(b.mode !== 'klausur'))
  for (const src of ordered) {
    if (!fs.existsSync(src.path)) result.errors.push(`Nicht gefunden: ${src.path}`)
    const files = sourceFiles(src, ignored)
    result.files[src.id] = files
    for (const file of files) {
      const id = `${src.subject_id}\0${file}`
      if (seen.has(id)) continue
      seen.add(id)
      try {
        const ext = path.extname(file).toLowerCase()
        const isText = TEXT_SUFFIXES.has(ext)
        if (IMAGE_SUFFIXES.has(ext) && src.mode === 'klausur') {
          const dir = path.dirname(file)
          const group = examImages.get(`${src.subject_id}\0${dir}`) ?? { subjectId: src.subject_id, dir, files: [] }
          group.files.push(file)
          examImages.set(`${src.subject_id}\0${dir}`, group)
        } else if (IMAGE_SUFFIXES.has(ext)) {
          result.sections.push({
            key: `${file}#B1`, path: file, kind: 'bild', label: 'Bild', subject_id: src.subject_id,
            hash: sha(fs.readFileSync(file)), text: '', pages: [0, 0], imageFiles: [file],
          })
        } else if (isText && src.mode === 'klausur') {
          result.sections.push(...textExam(file, readText(file), src.subject_id))
        } else if (isText) {
          const text = readText(file)
          result.sections.push(...splitMarkdown(file, text, src.subject_id))
          result.noteQuestions.push(...noteQuestions(file, text, src.subject_id))
        } else if (src.mode === 'klausur') {
          result.sections.push(...(await splitPdf(file, src.subject_id, true)))
        } else {
          result.sections.push(...(await splitPdf(file, src.subject_id, false)))
        }
      } catch (e) {
        // eine kaputte Datei soll den Scan nicht abbrechen
        result.errors.push(`${file}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  for (const group of examImages.values()) {
    try {
      result.sections.push(...imageExam(group.dir, group.files, group.subjectId))
    } catch (e) {
      result.errors.push(`${group.dir}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}

/** Screenshots einer Altklausur in Lesereihenfolge (Dateiname, Zahlen natürlich sortiert), in
 *  Gruppen zu höchstens EXAM_IMAGES Bildern. Der Abschnitt gehört zum Ordner. */
function imageExam(dir: string, files: string[], subjectId: number): Section[] {
  const sorted = [...files].sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'de', { numeric: true }))
  const groups: string[][] = []
  for (let i = 0; i < sorted.length; i += EXAM_IMAGES) groups.push(sorted.slice(i, i + EXAM_IMAGES))
  return groups.map((imgs, i) => ({
    key: `${dir}#B${i + 1}`, path: dir, kind: 'klausur' as const,
    label: groups.length > 1 ? `Screenshots ${i * EXAM_IMAGES + 1}–${i * EXAM_IMAGES + imgs.length}` : 'Screenshots',
    subject_id: subjectId, hash: sha(imgs.map((f) => `${path.basename(f)}:${sha(fs.readFileSync(f))}`).join('\n')),
    text: '', pages: [0, 0] as [number, number], imageFiles: imgs,
  }))
}

// --- Markdown und Text ------------------------------------------------

/** Liest eine Textdatei: UTF-8 (mit oder ohne BOM), UTF-16 mit BOM, sonst Windows-1252
 *  (typisch für ältere deutsche Texte aus Windows). Zeilenenden werden vereinheitlicht. */
export function readText(file: string): string {
  const buf = fs.readFileSync(file)
  let text: string
  if (buf[0] === 0xff && buf[1] === 0xfe) text = new TextDecoder('utf-16le').decode(buf)
  else if (buf[0] === 0xfe && buf[1] === 0xff) text = new TextDecoder('utf-16be').decode(buf)
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      text = new TextDecoder('windows-1252').decode(buf)
    }
  }
  return text.replace(/\r\n?/g, '\n')
}

/** Teilt einen zu langen Block: erst an Leerzeilen, dann an Zeilen, notfalls an Satzenden. */
function splitLong(body: string): string[] {
  const parts = (text: string, sep: RegExp, glue: string): string[] => {
    const pieces: string[] = []
    let cur = ''
    for (const part of text.split(sep)) {
      if (cur && cur.length + part.length > MD_MAX_CHARS) {
        pieces.push(cur)
        cur = ''
      }
      cur += part + glue
    }
    if (cur.trim()) pieces.push(cur)
    return pieces
  }
  return parts(body, /\n\n/, '\n\n').flatMap((p) =>
    p.length <= MD_MAX_CHARS
      ? [p]
      : parts(p, /\n/, '\n').flatMap((q) => (q.length <= MD_MAX_CHARS ? [q] : parts(q, /(?<=[.!?])\s+/, ' '))),
  )
}

function stripFrontmatter(text: string): string {
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 4)
    if (end !== -1) return text.slice(end + 4).replace(/^\n+/, '')
  }
  return text
}

/** Teilt an Überschriften (außerhalb von Codeblöcken) in (Überschrift, Inhalt). */
function blocks(text: string): [string, string][] {
  const out: [string, string[]][] = [['Anfang', []]]
  let inCode = false
  for (const line of splitLines(text)) {
    if (FENCE.test(line)) inCode = !inCode
    const m = inCode ? null : HEADING.exec(line)
    if (m) out.push([m[2], [line]])
    else out[out.length - 1][1].push(line)
  }
  return out.map(([h, lines]) => [h, lines.join('\n').trim()] as [string, string]).filter(([, body]) => body)
}

export function splitMarkdown(file: string, raw: string, subjectId: number): Section[] {
  const text = stripFrontmatter(raw)
  if (text.trim().length < MD_MIN_CHARS) return []
  const chunks: [string, string][] = []
  let label = ''
  let buf = ''
  for (const [heading, body] of blocks(text)) {
    // Überlange Einzelabschnitte weiter zerteilen
    const pieces = body.length > MD_MAX_CHARS ? splitLong(body) : [body]
    for (const piece of pieces) {
      if (buf && buf.length + piece.length > MD_MAX_CHARS) {
        chunks.push([label, buf])
        label = ''
        buf = ''
      }
      label = label || heading
      buf += piece + '\n\n'
    }
  }
  if (buf.trim()) chunks.push([label, buf])

  // Reiner Text hat meist keine Überschriften: dann Teile durchnummerieren
  const plain = path.extname(file).toLowerCase() === '.txt'
  const sections: Section[] = []
  chunks.forEach(([lbl, body], i) => {
    const full = `# ${stem(file)}\n\n${body.trim()}`
    if (chunks.length > 1 && full.length < MD_MIN_CHARS) return
    const label = plain && lbl === 'Anfang' ? (chunks.length > 1 ? `Teil ${i + 1}` : 'Ganzer Text') : lbl
    sections.push({
      key: `${file}#${i}`, path: file, kind: 'md', label, subject_id: subjectId, hash: sha(full), text: full, pages: [0, 0],
    })
  })
  return sections
}

/** Findet „Frage?::Antwort“-Zeilen und „> [!frage]“-Callouts. */
export function noteQuestions(file: string, text: string, subjectId: number): Question[] {
  const found: [string, string][] = []
  const lines = splitLines(stripFrontmatter(text))
  let inCode = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (FENCE.test(line)) {
      inCode = !inCode
    } else if (!inCode) {
      const callout = CALLOUT_START.exec(line)
      if (callout) {
        const question = callout[1].trim()
        const answer: string[] = []
        i++
        while (i < lines.length && lines[i].startsWith('>')) {
          answer.push(lines[i].slice(1).trim())
          i++
        }
        if (question && answer.some(Boolean)) found.push([question, answer.join('\n').trim()])
        continue
      }
      const qa = INLINE_QA.exec(line)
      if (qa) found.push([qa[1].trim(), qa[2].trim()])
    }
    i++
  }
  return found.map(([q, a]) =>
    emptyQuestion({
      kind: 'frei', text: q, answer: a, subject_id: subjectId, source_path: file, origin: 'notiz', approved: true,
      ext_key: noteKey(subjectId, file, q),
    }),
  )
}

const EXAM_TEXT_CHARS = 4_000 // Teilgröße langer Text-Altklausuren (rund 30–40 kurze Aufgaben)
// Beginn einer Hauptaufgabe: „12. …“, „12) …“ oder „Aufgabe 12 …“ – nicht „4.1 …“ (Teilaufgabe)
const TASK_START = /^\s*(?:Aufgabe\s+\d+\b|\d+[.)]\s)/i

/** Zahl der Hauptaufgaben im Text (zur Kontrolle der Übernahme). */
export function countTasks(text: string): number {
  return splitLines(text).filter((l) => TASK_START.test(l)).length
}

/** Altklausur als Text- oder Markdown-Datei. Lange Texte werden geteilt, aber nur vor einer neuen
 *  Hauptaufgabe, damit Ausgangslage und Teilaufgaben zusammenbleiben. */
function textExam(file: string, raw: string, subjectId: number): Section[] {
  const text = stripFrontmatter(raw).trim()
  if (!text) return []
  const parts: string[] = []
  let cur: string[] = []
  for (const line of splitLines(text)) {
    if (TASK_START.test(line) && cur.join('\n').length > EXAM_TEXT_CHARS) {
      parts.push(cur.join('\n').trim())
      cur = []
    }
    cur.push(line)
  }
  if (cur.join('').trim()) parts.push(cur.join('\n').trim())
  return parts.map((part, i) => ({
    key: `${file}#K${i + 1}`, path: file, kind: 'klausur' as const,
    label: parts.length > 1 ? `Altklausur Teil ${i + 1}` : 'Altklausur',
    subject_id: subjectId, hash: sha(`klausur:${part}`), text: part, pages: [0, 0] as [number, number],
  }))
}

// --- PDF --------------------------------------------------------------

// Seitenzahl je Dateiinhalt merken; das Einlesen läuft bei jedem Start
const pageCache = new Map<string, number>()

/** Lernstoff in Blöcke zu 15 Seiten; eine Altklausur bleibt am Stück, damit Aufgaben und
 *  Lösungen zusammen bleiben. */
async function splitPdf(file: string, subjectId: number, exam: boolean): Promise<Section[]> {
  const data = fs.readFileSync(file)
  const fileHash = sha(data)
  let n = pageCache.get(fileHash)
  if (n === undefined) {
    n = await pageCount(data)
    pageCache.set(fileHash, n)
  }
  const step = exam ? EXAM_PAGES : PDF_PAGES
  const sections: Section[] = []
  for (let start = 0; start < n; start += step) {
    const end = Math.min(start + step, n)
    sections.push(
      exam
        ? {
            key: `${file}#K${start + 1}`, path: file, kind: 'klausur',
            label: n <= EXAM_PAGES ? 'Altklausur' : `Altklausur S. ${start + 1}–${end}`,
            subject_id: subjectId, hash: sha(`klausur:${fileHash}:${start}:${end}`), text: '', pages: [start, end],
          }
        : {
            key: `${file}#S${start + 1}`, path: file, kind: 'pdf', label: `S. ${start + 1}–${end}`,
            subject_id: subjectId, hash: sha(`${fileHash}:${start}:${end}`), text: '', pages: [start, end],
          },
    )
  }
  return sections
}
