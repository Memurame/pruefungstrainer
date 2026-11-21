// Datentypen, die Hauptprozess und Oberfläche gemeinsam nutzen.

export type Kind = 'mc' | 'frei' | 'zuordnung'
export type Origin = 'ki' | 'manuell' | 'notiz' | 'klausur'
export type SourceMode = 'lernstoff' | 'klausur'

/** Zuordnung: je Zeile eine Entscheidung zwischen festen Antworten. */
export interface Item {
  text: string
  choices: string[]
  correct: number
}

export interface Question {
  id: number | null
  kind: Kind
  text: string
  options: string[]
  correct_index: number
  items: Item[]
  points: number // 0 = Standard des Fragetyps
  answer: string
  explanation: string
  difficulty: number
  subject_id: number | null
  source_path: string
  source_loc: string
  origin: Origin
  approved: boolean
  ext_key: string | null
  subject: string // nur zur Anzeige, kommt aus der subjects-Tabelle
}

export interface Subject {
  id: number
  name: string
}

export interface PracticeSet {
  id: number
  name: string
  minutes: number
  source_path: string | null
  count: number
}

export interface Source {
  id: number
  subject_id: number
  path: string
  kind: 'file' | 'dir'
  mode: SourceMode
}

/** Abschnitt einer Quelle, für den Fragen erzeugt werden (ohne Inhalt, der bleibt im Hauptprozess). */
export interface SectionInfo {
  key: string // eindeutig: absoluter Pfad + Abschnitt
  path: string
  kind: 'md' | 'pdf' | 'klausur'
  label: string
  subject_id: number
  hash: string
}

export interface ScanInfo {
  files: Record<number, string[]> // Quelle-ID -> enthaltene Dateien
  sections: SectionInfo[]
  errors: string[]
  newNoteQuestions: number
}

export interface Config {
  last_dir: string
  model: string
  questions_per_section: number
  ignore_dirs: string
}

export interface AppInfo {
  configFile: string
  dbFile: string
  hasApiKey: boolean
  keySource: 'env' | 'app' | null
  keyring: boolean // gespeicherter Key verschlüsselt im Schlüsselbund
}

export interface GenerateRequest {
  scope: 'subject' | 'selection' | 'all'
  subjectId: number | null
  keys: string[]
  count: number
  kinds: Kind[]
}

export interface Progress {
  job: 'scan' | 'generate' | 'grade'
  done: number
  total: number
  msg: string
}

export interface Grading {
  points: number
  feedback: string
}

export interface SubjectStat {
  name: string
  questions: number
  attempts: number
  rate: number | null
}

export interface ExportSummary {
  file: string
  subjects: number
  questions: number
  sets: number
}

/** Was die Oberfläche über window.api aufrufen kann. */
export interface Api {
  info(): Promise<AppInfo>
  getConfig(): Promise<Config>
  saveConfig(patch: Partial<Config>): Promise<Config>
  /** Prüft und speichert den Key; gibt eine Warnung zurück, falls er nicht geprüft werden konnte. */
  setApiKey(key: string): Promise<string | null>
  clearApiKey(): Promise<void>

  subjects(): Promise<Subject[]>
  addSubject(name: string): Promise<number>
  renameSubject(id: number, name: string): Promise<void>
  deleteSubject(id: number): Promise<void>
  mergeSubjects(sourceId: number, targetId: number): Promise<void>
  questionCounts(): Promise<Record<number, number>>

  sources(subjectId: number | null): Promise<Source[]>
  pickSources(subjectId: number, what: 'files' | 'folder' | 'exams'): Promise<boolean>
  setSourceMode(sourceId: number, mode: SourceMode): Promise<void>
  removeSources(sourceIds: number[], deleteQuestions: boolean): Promise<void>
  scan(): Promise<ScanInfo>
  generatedHashes(subjectId: number): Promise<Record<string, string>>
  generate(req: GenerateRequest): Promise<number>
  cancelGenerate(): Promise<void>

  questions(): Promise<Question[]>
  saveQuestion(q: Question): Promise<Question>
  deleteQuestions(ids: number[]): Promise<void>
  setApproved(ids: number[], approved: boolean): Promise<void>
  openSource(path: string): Promise<void>

  practiceSets(): Promise<PracticeSet[]>
  setSubjects(): Promise<Record<number, number[]>>
  addPracticeSet(name: string): Promise<number>
  renamePracticeSet(id: number, name: string): Promise<void>
  setPracticeMinutes(id: number, minutes: number): Promise<void>
  deletePracticeSet(id: number): Promise<void>
  setQuestionIds(setId: number): Promise<number[]>
  addToSet(setId: number, ids: number[]): Promise<void>
  reorderSet(setId: number, ids: number[]): Promise<void>

  successRates(): Promise<Record<number, [number, number]>>
  subjectStats(): Promise<SubjectStat[]>
  recordAttempt(questionId: number, points: number, maxPoints: number): Promise<number>
  updateAttempt(attemptId: number, points: number): Promise<void>
  grade(items: { questionId: number; answer: string }[]): Promise<{ results: (Grading | null)[]; errors: string[] }>

  exportData(subjectIds: number[]): Promise<ExportSummary | null>
  importData(): Promise<string | null>

  onProgress(cb: (p: Progress) => void): () => void
}
