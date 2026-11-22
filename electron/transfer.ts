// Export und Import von Fächern, Fragen und Übungssätzen als JSON-Datei. Quellen (Dateipfade) und Prüfungsergebnisse gehören nicht dazu. Beim Import werden
// Fächer und Übungssätze über ihren Namen zusammengeführt, vorhandene Fragen nicht doppelt angelegt.

import fs from 'node:fs'
import { emptyQuestion } from '../shared/logic'
import type { Question } from '../shared/types'
import { type Database, rekey, UserError } from './db'

const FORMAT = 'pruefungstrainer-export'
const VERSION = 1
const QUESTION_FIELDS = [
  'kind', 'title', 'text', 'options', 'correct_index', 'items', 'points', 'answer', 'explanation', 'difficulty',
  'source_path', 'source_loc', 'origin', 'approved', 'ext_key',
] as const

interface ExportFile {
  format: string
  version: number
  exported: string
  subjects: { name: string }[]
  questions: ({ subject: string } & Partial<Record<(typeof QUESTION_FIELDS)[number], unknown>>)[]
  sets: { name: string; minutes?: number; source_path?: string | null; questions: number[] }[]
}

function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function exportData(db: Database, subjectIds: Set<number>): ExportFile {
  const subjects = db.subjects().filter((s) => subjectIds.has(s.id))
  const questions = db.questions().filter((q) => q.subject_id != null && subjectIds.has(q.subject_id))
  const index = new Map(questions.map((q, n) => [q.id, n]))
  const sets: ExportFile['sets'] = []
  for (const s of db.practiceSets()) {
    const refs = db.setQuestionIds(s.id).flatMap((id) => (index.has(id) ? [index.get(id)!] : []))
    if (refs.length) sets.push({ name: s.name, minutes: s.minutes, source_path: s.source_path, questions: refs })
  }
  return {
    format: FORMAT, version: VERSION, exported: timestamp(),
    subjects: subjects.map((s) => ({ name: s.name })),
    questions: questions.map((q) => ({ subject: q.subject, ...Object.fromEntries(QUESTION_FIELDS.map((f) => [f, q[f]])) })),
    sets,
  }
}

export function writeExport(db: Database, subjectIds: Set<number>, file: string): ExportFile {
  const data = exportData(db, subjectIds)
  fs.writeFileSync(file, JSON.stringify(data, null, 1), 'utf8')
  return data
}

export interface ImportResult {
  subjectsNew: number
  questionsNew: number
  questionsKnown: number
  setsNew: number
  setsExtended: number
}

export function summary(r: ImportResult): string {
  return `${r.questionsNew} neue Fragen (${r.questionsKnown} waren schon vorhanden), ${r.subjectsNew} neue Fächer, ` +
    `${r.setsNew} neue und ${r.setsExtended} ergänzte Übungssätze.`
}

export function readImport(db: Database, file: string): ImportResult {
  let data: unknown
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new UserError(`Datei konnte nicht gelesen werden: ${e instanceof Error ? e.message : e}`)
  }
  const d = data as Partial<ExportFile>
  if (!d || typeof d !== 'object' || d.format !== FORMAT) throw new UserError('Das ist keine Exportdatei des Prüfungstrainers.')
  if ((d.version ?? 0) > VERSION) throw new UserError('Die Datei stammt aus einer neueren Version des Prüfungstrainers.')
  try {
    return importData(db, d as ExportFile)
  } catch (e) {
    if (e instanceof UserError) throw e
    throw new UserError(`Die Exportdatei ist unvollständig oder beschädigt (${e instanceof Error ? e.message : e}).`)
  }
}

function importData(db: Database, data: ExportFile): ImportResult {
  const result: ImportResult = { subjectsNew: 0, questionsNew: 0, questionsKnown: 0, setsNew: 0, setsExtended: 0 }
  const subjectIds = new Map(db.subjects().map((s) => [s.name, s.id]))
  const subjectId = (name: string) => {
    let id = subjectIds.get(name)
    if (id === undefined) {
      id = db.addSubject(name)
      subjectIds.set(name, id)
      result.subjectsNew++
    }
    return id
  }
  for (const s of data.subjects) subjectId(String(s.name))

  const ids: number[] = [] // Index in der Datei -> Frage-ID hier
  for (const raw of data.questions) {
    if (typeof raw.subject !== 'string' || typeof raw.text !== 'string' || typeof raw.kind !== 'string') {
      throw new Error('Frage ohne Fach, Typ oder Text')
    }
    const sid = subjectId(raw.subject)
    const fields = Object.fromEntries(QUESTION_FIELDS.filter((f) => f in raw).map((f) => [f, raw[f]])) as Partial<Question>
    const q = emptyQuestion({ ...fields, subject_id: sid, approved: Boolean(fields.approved) })
    if (q.ext_key) q.ext_key = rekey(q.ext_key, sid)
    const existing = db.findQuestion(q)
    if (existing != null) {
      ids.push(existing)
      result.questionsKnown++
    } else {
      db.saveQuestion(q)
      ids.push(q.id!)
      result.questionsNew++
    }
  }

  const sets = new Map(db.practiceSets().map((s) => [s.name, s]))
  for (const raw of data.sets) {
    const qids = raw.questions.map((n) => {
      if (ids[n] === undefined) throw new Error(`Übungssatz „${raw.name}“ verweist auf eine fehlende Frage`)
      return ids[n]
    })
    const known = sets.get(raw.name)
    if (known) {
      db.addToSet(known.id, qids)
      if (db.setQuestionIds(known.id).length > known.count) result.setsExtended++
    } else {
      let setId: number
      try {
        setId = db.addPracticeSet(raw.name, raw.minutes ?? 0, raw.source_path ?? null)
      } catch {
        continue
      }
      db.addToSet(setId, qids)
      result.setsNew++
    }
  }
  return result
}
