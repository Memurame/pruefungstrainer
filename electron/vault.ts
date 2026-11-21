// Liest die Quellen eines Fachs: teilt Markdown und PDFs in Abschnitte auf und findet manuell
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
const SUFFIXES = new Set(['.md', '.pdf'])

const HEADING = /^(#{1,3})\s+(.+?)\s*#*$/
const FENCE = /^\s*(```|~~~)/
// „Frage?::Antwort“ – das Fragezeichen grenzt das Format von Dataview-Feldern (key:: value) ab
const INLINE_QA = /^\s*(?:[-*]\s+)?(.+\?)\s*::\s*(.+)$/
const CALLOUT_START = /^>\s*\[!frage\][-+]?\s*(.*)$/i

export interface Section extends SectionInfo {
  text: string // nur Markdown
  pages: [number, number] // nur PDF, 0-basiert, Ende exklusiv
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
        if (path.extname(file).toLowerCase() === '.md') {
          // Zeilenenden vereinheitlichen
          const text = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n')
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
  return result
}

// --- Markdown ---------------------------------------------------------

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
    // Überlange Einzelabschnitte an Absätzen weiter zerteilen
    let pieces = [body]
    if (body.length > MD_MAX_CHARS) {
      pieces = []
      let cur = ''
      for (const para of body.split('\n\n')) {
        if (cur && cur.length + para.length > MD_MAX_CHARS) {
          pieces.push(cur)
          cur = ''
        }
        cur += para + '\n\n'
      }
      pieces.push(cur)
    }
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

  const sections: Section[] = []
  chunks.forEach(([lbl, body], i) => {
    const full = `# ${stem(file)}\n\n${body.trim()}`
    if (chunks.length > 1 && full.length < MD_MIN_CHARS) return
    sections.push({
      key: `${file}#${i}`, path: file, kind: 'md', label: lbl, subject_id: subjectId, hash: sha(full), text: full, pages: [0, 0],
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
