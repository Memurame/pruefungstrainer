// Reine Hilfsfunktionen ohne Node- oder DOM-Abhängigkeiten.

import type { Kind, Origin, Question } from './types'

export const KIND_LABEL: Record<Kind, string> = { mc: 'Multiple Choice', frei: 'Freitext', zuordnung: 'Zuordnung' }
export const ORIGIN_LABEL: Record<Origin, string> = { ki: 'KI', manuell: 'Manuell', notiz: 'Notiz (::)', klausur: 'Altklausur' }
const DEFAULT_POINTS = { mc: 1, frei: 3 }

export function maxPoints(q: Question): number {
  if (q.points) return q.points
  return q.kind === 'zuordnung' ? q.items.length : DEFAULT_POINTS[q.kind]
}

export function emptyQuestion(patch: Partial<Question> = {}): Question {
  return {
    id: null, kind: 'frei', text: '', options: [], correct_index: -1, items: [], points: 0, answer: '',
    explanation: '', difficulty: 2, subject_id: null, source_path: '', source_loc: '', origin: 'manuell',
    approved: false, ext_key: null, subject: '', ...patch,
  }
}

/** Zahlen ohne überflüssige Nachkommastellen: 1.5 -> „1.5“, 2 -> „2“. */
export function num(n: number): string {
  return String(Math.round(n * 100) / 100)
}

export function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() ?? p
}

export function stem(p: string): string {
  const name = basename(p)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

export function dirname(p: string): string {
  const i = p.replace(/\/+$/, '').lastIndexOf('/')
  return i > 0 ? p.slice(0, i) : '/'
}

/** Einzeilige Kurzfassung für Listen: die Überschrift (**Aufgabe …**) oder die erste Zeile. */
export function questionTitle(q: Question): string {
  const line = q.text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  // Markdown-Zeichen für die einzeilige Anzeige entfernen
  return line.replace(/^#+\s*/, '').replace(/\*\*|__|`/g, '').replace(/^\*|\*$/g, '').trim()
}

export function sourceText(q: Question): string {
  if (!q.source_path) return ''
  const name = basename(q.source_path)
  return q.source_loc ? `${name} – ${q.source_loc}` : name
}

/** Note nach IHK-Notenschlüssel. */
export function gradeFor(percent: number): string {
  const steps: [number, string][] = [
    [92, '1 (sehr gut)'], [81, '2 (gut)'], [67, '3 (befriedigend)'], [50, '4 (ausreichend)'], [30, '5 (mangelhaft)'],
  ]
  for (const [limit, grade] of steps) if (percent >= limit) return grade
  return '6 (ungenügend)'
}

// --- Markdown ---------------------------------------------------------

const FENCE = /^\s*(```|~~~)/
// Aufzählungspunkt mitten in einer Zelle („• a • b“) beginnt eine neue Zeile
const CELL_BULLET = /(?<=[^|\s])\s+•\s*/g

/** In Tabellenzellen werden Aufzählungen zu Zeilenwechseln. Einfache Zeilenumbrüche macht
 *  die Markdown-Anzeige selbst sichtbar. */
export function prepareMarkdown(md: string): string {
  let inCode = false
  return md
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) inCode = !inCode
      else if (!inCode && line.trimStart().startsWith('|')) return line.replace(CELL_BULLET, '<br>• ')
      return line
    })
    .join('\n')
}

export interface Table {
  header: string[]
  rows: string[][]
}

/** Leere Zellen sind in der Prüfung zum Ausfüllen da. */
export function fillable(t: Table): boolean {
  return t.rows.some((row) => row.some((c) => !c))
}

export function tableMarkdown(t: Table): string {
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, '<br>')
  const lines = [
    '| ' + t.header.map(cell).join(' | ') + ' |',
    '|' + '---|'.repeat(t.header.length),
    ...t.rows.map((row) => '| ' + row.map(cell).join(' | ') + ' |'),
  ]
  return lines.join('\n')
}

const TABLE_SEP = /^:?-+:?$/

function cells(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

/** Teilt Markdown an der ersten Tabelle in (Text davor, Tabelle, Text danach). */
export function splitTable(md: string): [string, Table, string] | null {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => l.trimStart().startsWith('|'))
  if (start < 0) return null
  let end = start
  while (end < lines.length && lines[end].trimStart().startsWith('|')) end++
  const rows = lines.slice(start, end).map(cells)
  if (rows.length < 3 || !rows[1].every((c) => TABLE_SEP.test(c))) return null
  const header = rows[0]
  const body = rows.slice(2).map((row) => [...row, ...Array(header.length).fill('')].slice(0, header.length))
  return [lines.slice(0, start).join('\n').trim(), { header, rows: body }, lines.slice(end).join('\n').trim()]
}

/** Freitextfrage mit Tabelle zum Ausfüllen: (Text davor, Tabelle, Text danach). */
export function fillTable(q: Question): [string, Table, string] | null {
  if (q.kind !== 'frei') return null
  const parts = splitTable(q.text)
  return parts && fillable(parts[1]) ? parts : null
}

function mdCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/** Zuordnungszeilen als Tabelle, mit Lösung und optional den Antworten des Prüflings. */
export function itemsMarkdown(q: Question, answers: number[] | null = null, withSolution = true): string {
  const head = ['Nr.', 'Aussage', withSolution ? 'Lösung' : 'Auswahl']
  if (answers) head.push('Deine Wahl')
  let md = '| ' + head.join(' | ') + ' |\n|' + '---|'.repeat(head.length) + '\n'
  q.items.forEach((item, n) => {
    const row = [String(n + 1), mdCell(item.text)]
    if (withSolution) row.push(item.correct >= 0 ? `**${mdCell(item.choices[item.correct])}**` : '?')
    else row.push(mdCell(item.choices.join(' / ')))
    if (answers) {
      const a = answers[n]
      row.push(a === item.correct ? '✓' : `✗ ${a >= 0 ? mdCell(item.choices[a]) : '–'}`)
    }
    md += '| ' + row.join(' | ') + ' |\n'
  })
  return md + '\n'
}

export function questionMarkdown(q: Question, withSolution = true): string {
  let md = q.text + '\n\n'
  if (q.kind === 'mc') {
    q.options.forEach((opt, i) => {
      const mark = withSolution && i === q.correct_index ? ' **✓**' : ''
      md += `${String.fromCharCode(65 + i)}) ${opt}${mark}\n\n`
    })
  }
  if (q.kind === 'zuordnung') md += itemsMarkdown(q, null, withSolution)
  md += `*${num(maxPoints(q))} Punkte*\n\n`
  if (withSolution) {
    if (q.kind !== 'mc' && q.answer) md += `---\n\n**Musterlösung:**\n\n${q.answer}\n\n`
    if (q.explanation) md += `**Erläuterung:**\n\n${q.explanation}\n\n`
    if (q.source_path) md += `*Quelle: ${sourceText(q)}*\n`
  }
  return md
}

/** Deine Tabelle und die Lösungstabelle Zeile für Zeile nebeneinander, falls die Lösung
 *  dieselbe Form wie die Frage hat. */
export function comparisonMarkdown(q: Question, answer: string): string | null {
  const parts = fillTable(q)
  const solution = splitTable(q.answer)
  if (!parts || !solution) return null
  const qt = parts[1]
  const st = solution[1]
  if (st.rows.length !== qt.rows.length || st.header.length !== qt.header.length) return null
  const mine = answer ? splitTable(answer) : null
  const at = mine && mine[1].rows.length === qt.rows.length ? mine[1] : null
  const fill = qt.header.map((_, j) => j).filter((j) => qt.rows.some((row) => !row[j]))

  const header: string[] = []
  qt.header.forEach((h, j) => {
    if (!fill.includes(j)) header.push(h)
    else if (fill.length === 1) header.push('Deine Antwort', 'Musterlösung')
    else header.push(`${h} – deine`, `${h} – Lösung`)
  })
  const rows = qt.rows.map((row, i) => {
    const out: string[] = []
    row.forEach((given, j) => {
      if (!fill.includes(j)) out.push(given)
      else if (given) out.push(given, given) // vorgegebene Zelle in einer Ausfüllspalte
      else out.push((at ? at.rows[i][j] : '') || '–', st.rows[i][j] || '–')
    })
    return out
  })
  let md = `### Deine Antwort und Musterlösung\n\n${tableMarkdown({ header, rows })}\n\n`
  const notes = [solution[0], solution[2]].filter(Boolean).join('\n\n')
  if (notes) md += `**Hinweise zur Lösung:**\n\n${notes}\n\n`
  return md
}

// --- Zuordnungen im Bearbeiten-Dialog ---------------------------------

export function itemsToText(items: Question['items']): string {
  return items
    .map((i) => `${i.text} :: ` + i.choices.map((c, n) => (n === i.correct ? '*' : '') + c).join(' | '))
    .join('\n')
}

/** Liest „Aussage :: Wahl A | *Wahl B“-Zeilen; null bei Formatfehlern. */
export function itemsFromText(text: string): Question['items'] | null {
  const items: Question['items'] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const at = line.lastIndexOf('::')
    if (at < 0) return null
    const statement = line.slice(0, at).trim()
    const choices = line.slice(at + 2).split('|').map((c) => c.trim()).filter(Boolean)
    const marked = choices.flatMap((c, n) => (c.startsWith('*') ? [n] : []))
    if (!statement || choices.length < 2 || marked.length !== 1) return null
    items.push({ text: statement, choices: choices.map((c) => c.replace(/^\*+/, '').trim()), correct: marked[0] })
  }
  return items
}

// --- Prüfung ----------------------------------------------------------

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export { shuffle }

export function pickQuestions(
  pool: Question[], n: number, rates: Record<number, [number, number]>, preferWeak: boolean,
): Question[] {
  if (!preferWeak) return shuffle(pool).slice(0, n)
  // Gewichtete Ziehung ohne Zurücklegen: schwache und unbekannte Fragen häufiger
  const weight = (q: Question) => {
    const r = q.id != null ? rates[q.id] : undefined
    return r ? 1 + 4 * (1 - r[0]) : 2
  }
  const keyed = pool
    .map((q) => ({ q, key: Math.random() ** (1 / weight(q)) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.q)
  return shuffle(keyed.slice(0, n))
}
