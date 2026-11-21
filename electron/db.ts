// SQLite-Speicher für Fächer, Fragen, Übungssätze, generierte Abschnitte und Prüfungsergebnisse.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { stem } from '../shared/logic'
import type { Item, PracticeSet, Question, Source, SourceMode, Subject, SubjectStat } from '../shared/types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS subject_sources (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'lernstoff',
    UNIQUE (subject_id, path)
);
CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '[]',
    correct_index INTEGER NOT NULL DEFAULT -1,
    items TEXT NOT NULL DEFAULT '[]',
    points REAL NOT NULL DEFAULT 0,
    answer TEXT NOT NULL DEFAULT '',
    explanation TEXT NOT NULL DEFAULT '',
    difficulty INTEGER NOT NULL DEFAULT 2,
    subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
    source_path TEXT NOT NULL DEFAULT '',
    source_loc TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL,
    approved INTEGER NOT NULL DEFAULT 0,
    ext_key TEXT UNIQUE,
    created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS generated (
    subject_id INTEGER NOT NULL,
    section_key TEXT NOT NULL,
    hash TEXT NOT NULL,
    ts REAL NOT NULL,
    PRIMARY KEY (subject_id, section_key)
);
CREATE TABLE IF NOT EXISTS practice_sets (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    minutes INTEGER NOT NULL DEFAULT 0,
    source_path TEXT,
    created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS practice_set_questions (
    set_id INTEGER NOT NULL REFERENCES practice_sets(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    pos INTEGER NOT NULL,
    PRIMARY KEY (set_id, question_id)
);
CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    ts REAL NOT NULL,
    points REAL NOT NULL,
    max_points REAL NOT NULL
);
`

/** Fehler, deren Text direkt in der Oberfläche angezeigt werden kann. */
export class UserError extends Error {}

const now = () => Date.now() / 1000

export function noteKey(subjectId: number, file: string, question: string): string {
  const h = crypto.createHash('sha256').update(question).digest('hex').slice(0, 16)
  return `notiz:${subjectId}:${file}:${h}`
}

export function examKey(subjectId: number, file: string, number: string): string {
  return `klausur:${subjectId}:${file}:${number}`
}

/** Tauscht das Fach in einem ext_key („herkunft:fach:rest“) aus. */
export function rekey(key: string, subjectId: number): string {
  const first = key.indexOf(':')
  const second = key.indexOf(':', first + 1)
  return `${key.slice(0, first)}:${subjectId}:${key.slice(second + 1)}`
}

type Row = Record<string, SQLInputValue>

function isUnique(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/.test(e.message)
}

export class Database {
  private db: DatabaseSync

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file, { timeout: 30_000 })
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
  }

  // --- Grundlagen -----------------------------------------------------

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[]
  }

  private run(sql: string, ...params: SQLInputValue[]) {
    const r = this.db.prepare(sql).run(...params)
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** Sicherung einmal pro Tag (die erste des Tages bleibt), die letzten 14 bleiben erhalten. */
  backup(): void {
    const dir = path.join(path.dirname(this.file), 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const day = new Date().toISOString().slice(0, 10)
    const target = path.join(dir, `pruefungstrainer-${day}.sqlite3`)
    if (!fs.existsSync(target)) this.db.prepare('VACUUM INTO ?').run(target)
    const old = fs.readdirSync(dir).filter((f) => /^pruefungstrainer-\d{4}-\d{2}-\d{2}\.sqlite3$/.test(f)).sort()
    for (const f of old.slice(0, -14)) fs.rmSync(path.join(dir, f))
  }

  close(): void {
    this.db.close()
  }

  // --- Altklausuren als Übungssätze -----------------------------------

  /** Legt den Übungssatz einer Altklausur an bzw. ergänzt fehlende Aufgaben am Ende. */
  private syncExamSetIds(file: string, ids: number[], minutes: number): void {
    const row = this.get('SELECT id, minutes FROM practice_sets WHERE source_path=?', file)
    let setId: number
    if (row) {
      setId = Number(row.id)
      if (minutes && !Number(row.minutes)) this.run('UPDATE practice_sets SET minutes=? WHERE id=?', minutes, setId)
    } else {
      const base = stem(file)
      let name = base
      for (let n = 2; this.get('SELECT 1 AS x FROM practice_sets WHERE name=?', name); n++) name = `${base} (${n})`
      setId = this.run('INSERT INTO practice_sets (name, minutes, source_path, created) VALUES (?,?,?,?)', name, minutes, file, now()).id
    }
    this.appendToSet(setId, ids)
  }

  private appendToSet(setId: number, ids: number[]): void {
    let pos = Number(this.get('SELECT COALESCE(MAX(pos), -1) AS p FROM practice_set_questions WHERE set_id=?', setId)?.p ?? -1)
    for (const qid of ids) {
      pos += this.run('INSERT OR IGNORE INTO practice_set_questions VALUES (?,?,?)', setId, qid, pos + 1).changes
    }
  }

  // --- Fächer ---------------------------------------------------------

  subjects(): Subject[] {
    return this.all('SELECT id, name FROM subjects ORDER BY name COLLATE NOCASE').map((r) => ({ id: Number(r.id), name: String(r.name) }))
  }

  addSubject(name: string): number {
    try {
      return this.run('INSERT INTO subjects (name, created) VALUES (?,?)', name, now()).id
    } catch (e) {
      if (isUnique(e)) throw new UserError(`Ein Fach „${name}“ gibt es schon.`)
      throw e
    }
  }

  renameSubject(id: number, name: string): void {
    try {
      this.run('UPDATE subjects SET name=? WHERE id=?', name, id)
    } catch (e) {
      if (isUnique(e)) throw new UserError(`Ein Fach „${name}“ gibt es schon.`)
      throw e
    }
  }

  deleteSubject(id: number): void {
    this.tx(() => {
      this.run('DELETE FROM questions WHERE subject_id=?', id)
      this.run('DELETE FROM generated WHERE subject_id=?', id)
      this.run('DELETE FROM subjects WHERE id=?', id)
    })
  }

  /** Verschiebt Quellen, Fragen und Generierungsstand von source nach target. */
  mergeSubjects(sourceId: number, targetId: number): void {
    this.tx(() => {
      this.run(
        'INSERT OR IGNORE INTO subject_sources (subject_id, path, kind, mode) SELECT ?, path, kind, mode FROM subject_sources WHERE subject_id=?',
        targetId, sourceId,
      )
      this.run('INSERT OR IGNORE INTO generated SELECT ?, section_key, hash, ts FROM generated WHERE subject_id=?', targetId, sourceId)
      for (const r of this.all('SELECT id, ext_key FROM questions WHERE subject_id=? AND ext_key IS NOT NULL', sourceId)) {
        const key = rekey(String(r.ext_key), targetId)
        if (this.get('SELECT 1 AS x FROM questions WHERE ext_key=?', key)) this.run('DELETE FROM questions WHERE id=?', r.id)
        else this.run('UPDATE questions SET ext_key=? WHERE id=?', key, r.id)
      }
      this.run('UPDATE questions SET subject_id=? WHERE subject_id=?', targetId, sourceId)
      this.run('DELETE FROM generated WHERE subject_id=?', sourceId)
      this.run('DELETE FROM subjects WHERE id=?', sourceId)
    })
  }

  sources(subjectId: number | null = null): Source[] {
    const rows = subjectId == null
      ? this.all('SELECT * FROM subject_sources ORDER BY path')
      : this.all('SELECT * FROM subject_sources WHERE subject_id=? ORDER BY path', subjectId)
    return rows.map((r) => ({
      id: Number(r.id), subject_id: Number(r.subject_id), path: String(r.path),
      kind: r.kind === 'dir' ? 'dir' : 'file', mode: r.mode === 'klausur' ? 'klausur' : 'lernstoff',
    }))
  }

  addSource(subjectId: number, file: string, kind: 'file' | 'dir', mode: SourceMode = 'lernstoff'): void {
    this.tx(() => {
      this.run('INSERT OR IGNORE INTO subject_sources (subject_id, path, kind, mode) VALUES (?,?,?,?)', subjectId, file, kind, mode)
      this.run('UPDATE subject_sources SET mode=? WHERE subject_id=? AND path=?', mode, subjectId, file)
    })
  }

  setSourceMode(sourceId: number, mode: SourceMode): void {
    this.run('UPDATE subject_sources SET mode=? WHERE id=?', mode, sourceId)
  }

  /** Entfernt eine Quelle; optional samt der Fragen aus ihren Dateien. */
  removeSource(source: Source, files: string[], deleteQuestions: boolean): void {
    this.tx(() => {
      this.run('DELETE FROM subject_sources WHERE id=?', source.id)
      if (!deleteQuestions) return
      for (const f of files) {
        this.run('DELETE FROM questions WHERE subject_id=? AND source_path=?', source.subject_id, f)
        this.run('DELETE FROM generated WHERE subject_id=? AND substr(section_key, 1, ?) = ?', source.subject_id, [...f].length + 1, f + '#')
      }
    })
  }

  // --- Fragen ---------------------------------------------------------

  private toQuestion(r: Row): Question {
    return {
      id: Number(r.id), kind: r.kind as Question['kind'], text: String(r.text),
      options: JSON.parse(String(r.options)) as string[], correct_index: Number(r.correct_index),
      items: JSON.parse(String(r.items)) as Item[], points: Number(r.points), answer: String(r.answer),
      explanation: String(r.explanation), difficulty: Number(r.difficulty),
      subject_id: r.subject_id == null ? null : Number(r.subject_id), source_path: String(r.source_path),
      source_loc: String(r.source_loc), origin: r.origin as Question['origin'], approved: Boolean(r.approved),
      ext_key: r.ext_key == null ? null : String(r.ext_key), subject: r.subject_name == null ? '' : String(r.subject_name),
    }
  }

  /** Speichert eine Frage. Gibt false zurück, wenn es sie (gleicher ext_key) schon gibt. */
  saveQuestion(q: Question): boolean {
    const values: SQLInputValue[] = [
      q.kind, q.text, JSON.stringify(q.options), q.correct_index, JSON.stringify(q.items), q.points, q.answer,
      q.explanation, q.difficulty, q.subject_id, q.source_path, q.source_loc, q.origin, q.approved ? 1 : 0, q.ext_key,
    ]
    if (q.id == null) {
      const r = this.run(
        'INSERT OR IGNORE INTO questions (kind, text, options, correct_index, items, points, answer, explanation,' +
          ' difficulty, subject_id, source_path, source_loc, origin, approved, ext_key, created)' +
          ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ...values, now(),
      )
      if (!r.changes) return false
      q.id = r.id
    } else {
      this.run(
        'UPDATE questions SET kind=?, text=?, options=?, correct_index=?, items=?, points=?, answer=?, explanation=?,' +
          ' difficulty=?, subject_id=?, source_path=?, source_loc=?, origin=?, approved=?, ext_key=? WHERE id=?',
        ...values, q.id,
      )
    }
    return true
  }

  question(id: number): Question | null {
    const r = this.get('SELECT q.*, s.name AS subject_name FROM questions q LEFT JOIN subjects s ON s.id = q.subject_id WHERE q.id=?', id)
    return r ? this.toQuestion(r) : null
  }

  /** ID einer gleichen, schon gespeicherten Frage (gleicher ext_key bzw. gleiches Fach, gleicher Typ und Text). */
  findQuestion(q: Question): number | null {
    const row = q.ext_key
      ? this.get('SELECT id FROM questions WHERE ext_key=?', q.ext_key)
      : this.get('SELECT id FROM questions WHERE subject_id=? AND kind=? AND text=?', q.subject_id, q.kind, q.text)
    return row ? Number(row.id) : null
  }

  /** Übernimmt eine Klausuraufgabe; eine schon vorhandene (gleiche Nummer) wird mit dem neuen Stand
   *  überschrieben, Freigabe und Ergebnisse bleiben. true, wenn sie neu ist. */
  upsertExamQuestion(q: Question): boolean {
    const r = this.run(
      'UPDATE questions SET kind=?, text=?, options=?, correct_index=?, items=?, points=?, answer=?, explanation=?, source_loc=? WHERE ext_key=?',
      q.kind, q.text, JSON.stringify(q.options), q.correct_index, JSON.stringify(q.items), q.points, q.answer,
      q.explanation, q.source_loc, q.ext_key,
    )
    if (r.changes) return false
    return this.saveQuestion(q)
  }

  /** Übernimmt Fragen aus Notizen; bestehende werden aktualisiert. Gibt die Zahl neuer zurück. */
  upsertNoteQuestions(questions: Question[]): number {
    return this.tx(() => {
      let fresh = 0
      for (const q of questions) {
        if (this.run('UPDATE questions SET answer=? WHERE ext_key=?', q.answer, q.ext_key).changes === 0) {
          fresh++
          this.run(
            'INSERT INTO questions (kind, text, answer, subject_id, source_path, origin, approved, ext_key, created) VALUES (?,?,?,?,?,?,?,?,?)',
            q.kind, q.text, q.answer, q.subject_id, q.source_path, q.origin, q.approved ? 1 : 0, q.ext_key, now(),
          )
        }
      }
      return fresh
    })
  }

  deleteQuestions(ids: number[]): void {
    this.tx(() => ids.forEach((id) => this.run('DELETE FROM questions WHERE id=?', id)))
  }

  setApproved(ids: number[], approved: boolean): void {
    this.tx(() => ids.forEach((id) => this.run('UPDATE questions SET approved=? WHERE id=?', approved ? 1 : 0, id)))
  }

  questions(): Question[] {
    return this.all(
      'SELECT q.*, s.name AS subject_name FROM questions q LEFT JOIN subjects s ON s.id = q.subject_id' +
        ' ORDER BY s.name COLLATE NOCASE, q.source_path, q.id',
    ).map((r) => this.toQuestion(r))
  }

  questionCounts(): Record<number, number> {
    const out: Record<number, number> = {}
    for (const r of this.all('SELECT subject_id, COUNT(*) AS n FROM questions GROUP BY subject_id')) {
      if (r.subject_id != null) out[Number(r.subject_id)] = Number(r.n)
    }
    return out
  }

  // --- Übungssätze ----------------------------------------------------

  practiceSets(): PracticeSet[] {
    return this.all(
      'SELECT s.id, s.name, s.minutes, s.source_path, COUNT(q.question_id) AS n FROM practice_sets s' +
        ' LEFT JOIN practice_set_questions q ON q.set_id = s.id GROUP BY s.id ORDER BY s.name COLLATE NOCASE',
    ).map((r) => ({
      id: Number(r.id), name: String(r.name), minutes: Number(r.minutes),
      source_path: r.source_path == null ? null : String(r.source_path), count: Number(r.n),
    }))
  }

  /** Übungssatz-ID -> Fächer, aus denen er Fragen enthält. */
  setSubjects(): Record<number, number[]> {
    const out: Record<number, number[]> = {}
    for (const r of this.all(
      'SELECT DISTINCT p.set_id, q.subject_id FROM practice_set_questions p JOIN questions q ON q.id = p.question_id',
    )) {
      ;(out[Number(r.set_id)] ??= []).push(Number(r.subject_id))
    }
    return out
  }

  addPracticeSet(name: string, minutes = 0, sourcePath: string | null = null): number {
    try {
      return this.run('INSERT INTO practice_sets (name, minutes, source_path, created) VALUES (?,?,?,?)', name, minutes, sourcePath, now()).id
    } catch (e) {
      if (isUnique(e)) throw new UserError(`Einen Übungssatz „${name}“ gibt es schon.`)
      throw e
    }
  }

  renamePracticeSet(id: number, name: string): void {
    try {
      this.run('UPDATE practice_sets SET name=? WHERE id=?', name, id)
    } catch (e) {
      if (isUnique(e)) throw new UserError(`Einen Übungssatz „${name}“ gibt es schon.`)
      throw e
    }
  }

  setPracticeMinutes(id: number, minutes: number): void {
    this.run('UPDATE practice_sets SET minutes=? WHERE id=?', minutes, id)
  }

  deletePracticeSet(id: number): void {
    this.run('DELETE FROM practice_sets WHERE id=?', id)
  }

  setQuestionIds(setId: number): number[] {
    return this.all('SELECT question_id FROM practice_set_questions WHERE set_id=? ORDER BY pos', setId).map((r) => Number(r.question_id))
  }

  addToSet(setId: number, ids: number[]): void {
    this.tx(() => this.appendToSet(setId, ids))
  }

  /** Setzt Inhalt und Reihenfolge eines Satzes (Entfernen = weglassen). */
  reorderSet(setId: number, ids: number[]): void {
    this.tx(() => {
      this.run('DELETE FROM practice_set_questions WHERE set_id=?', setId)
      ids.forEach((qid, pos) => this.run('INSERT INTO practice_set_questions VALUES (?,?,?)', setId, qid, pos))
    })
  }

  syncExamSet(file: string, extKeys: string[], minutes: number): void {
    this.tx(() => {
      const ids = extKeys.flatMap((key) => this.all('SELECT id FROM questions WHERE ext_key=?', key).map((r) => Number(r.id)))
      this.syncExamSetIds(file, ids, minutes)
    })
  }

  // --- Generierte Abschnitte ------------------------------------------

  generatedHashes(subjectId: number): Record<string, string> {
    const out: Record<string, string> = {}
    for (const r of this.all('SELECT section_key, hash FROM generated WHERE subject_id=?', subjectId)) out[String(r.section_key)] = String(r.hash)
    return out
  }

  markGenerated(subjectId: number, key: string, hash: string): void {
    this.run('INSERT OR REPLACE INTO generated VALUES (?,?,?,?)', subjectId, key, hash, now())
  }

  // --- Statistik ------------------------------------------------------

  recordAttempt(questionId: number, points: number, max: number): number {
    return this.run('INSERT INTO attempts (question_id, ts, points, max_points) VALUES (?,?,?,?)', questionId, now(), points, max).id
  }

  updateAttempt(attemptId: number, points: number): void {
    this.run('UPDATE attempts SET points=? WHERE id=?', points, attemptId)
  }

  /** question_id -> (Anteil erreichter Punkte, Anzahl Versuche). */
  successRates(): Record<number, [number, number]> {
    const out: Record<number, [number, number]> = {}
    for (const r of this.all('SELECT question_id, SUM(points)/SUM(max_points) AS rate, COUNT(*) AS n FROM attempts GROUP BY question_id')) {
      out[Number(r.question_id)] = [Number(r.rate ?? 0), Number(r.n)]
    }
    return out
  }

  subjectStats(): SubjectStat[] {
    return this.all(
      'SELECT s.name, COUNT(DISTINCT q.id) AS nq, COUNT(a.id) AS na, SUM(a.points)/SUM(a.max_points) AS rate' +
        ' FROM subjects s LEFT JOIN questions q ON q.subject_id = s.id LEFT JOIN attempts a ON a.question_id = q.id' +
        ' GROUP BY s.id ORDER BY s.name COLLATE NOCASE',
    ).map((r) => ({ name: String(r.name), questions: Number(r.nq), attempts: Number(r.na), rate: r.rate == null ? null : Number(r.rate) }))
  }
}
