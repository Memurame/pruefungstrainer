// Anbindung an die Claude API: Fragen erzeugen, Altklausuren übernehmen und Freitextantworten bewerten.

import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { basename, emptyQuestion, maxPoints } from '../shared/logic'
import type { Grading, Kind, Question } from '../shared/types'
import { examKey } from './db'
import { markedText, pdfExcerpt } from './pdf'
import type { Section } from './vault'

// Bei einer Ablehnung durch die Sicherheitsfilter beantwortet automatisch ein passendes
// Ersatzmodell die Anfrage, statt dass die Generierung abbricht.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

export class AIError extends Error {
  /** Weitere Anfragen sind sinnlos (Key ungültig, keine Verbindung). */
  constructor(message: string, readonly fatal = false) {
    super(message)
  }
}

const GeneratedSet = z.object({
  questions: z.array(z.object({
    kind: z.string(),
    question: z.string(),
    options: z.array(z.string()),
    correct_index: z.number().int(),
    answer: z.string(),
    explanation: z.string(),
    difficulty: z.number().int(),
    location: z.string(),
  })),
})

const ExamSet = z.object({
  minutes: z.number().int(),
  tasks: z.array(z.object({
    number: z.string(),
    heading: z.string(),
    kind: z.enum(['mc', 'frei', 'zuordnung']),
    question: z.string(),
    options: z.array(z.string()),
    correct_index: z.number().int(),
    items: z.array(z.object({ text: z.string(), choices: z.array(z.string()), correct_index: z.number().int() })),
    answer: z.string(),
    points: z.number(),
    page: z.number().int(),
    has_solution: z.boolean(),
  })),
})

const GradingSchema = z.object({ points: z.number(), feedback: z.string() })

const GENERATE_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['mc', 'frei'] },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correct_index: { type: 'integer' },
          answer: { type: 'string' },
          explanation: { type: 'string' },
          difficulty: { type: 'integer' },
          location: { type: 'string' },
        },
        required: ['kind', 'question', 'options', 'correct_index', 'answer', 'explanation', 'difficulty', 'location'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
}

const EXAM_SCHEMA = {
  type: 'object',
  properties: {
    minutes: { type: 'integer' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'string' },
          heading: { type: 'string' },
          kind: { type: 'string', enum: ['mc', 'frei', 'zuordnung'] },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correct_index: { type: 'integer' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                choices: { type: 'array', items: { type: 'string' } },
                correct_index: { type: 'integer' },
              },
              required: ['text', 'choices', 'correct_index'],
              additionalProperties: false,
            },
          },
          answer: { type: 'string' },
          points: { type: 'number' },
          page: { type: 'integer' },
          has_solution: { type: 'boolean' },
        },
        required: ['number', 'heading', 'kind', 'question', 'options', 'correct_index', 'items', 'answer', 'points', 'page', 'has_solution'],
        additionalProperties: false,
      },
    },
  },
  required: ['minutes', 'tasks'],
  additionalProperties: false,
}

const GRADE_SCHEMA = {
  type: 'object',
  properties: { points: { type: 'number' }, feedback: { type: 'string' } },
  required: ['points', 'feedback'],
  additionalProperties: false,
}

const GENERATE_SYSTEM = `\
Du erstellst Prüfungsfragen aus Lernmaterial eines Studierenden bzw. Auszubildenden. \
Die Fragen dienen als Probeprüfung und sollen sich wie eine echte schriftliche Prüfung anfühlen.

Anforderungen:
- Jede Frage muss allein mit dem gegebenen Material beantwortbar sein.
- Prüfe Verständnis und Anwendung, nicht Formalien des Dokuments (keine Fragen wie \
"Was steht auf Seite 3?" oder "Wie heißt die Überschrift?").
- Verteile die Fragen über die wichtigsten Inhalte des Abschnitts statt mehrere Fragen \
zum selben Detail zu stellen. Wenn der Abschnitt kaum prüfungsrelevanten Inhalt hat \
(z. B. Inhaltsverzeichnis, Literaturliste, Deckblatt), erzeuge weniger oder gar keine Fragen.
- Schreibe in der Sprache des Materials; im Zweifel Deutsch. Formeln in Markdown/LaTeX ($...$), \
Code in Markdown-Codeblöcken.

Felder:
- kind "mc": genau 4 Antwortoptionen in "options", genau eine ist richtig, ihr Index (0–3) steht \
in "correct_index". Falsche Optionen sollen plausibel sein und typische Fehlvorstellungen abbilden, \
nicht offensichtlich falsch. Die Position der richtigen Antwort soll variieren. "answer" enthält \
die richtige Option als Text.
- kind "frei": "options" ist leer, "correct_index" ist -1. "answer" ist eine Musterlösung \
mit den Kernpunkten, die für volle Punktzahl (3 Punkte) genannt werden müssen.
- "explanation": kurze Begründung, warum die Antwort richtig ist (bei MC auch, warum die \
anderen falsch sind).
- "difficulty": 1 = leicht, 2 = mittel, 3 = schwer.
- "location": wo im Material die Antwort steht (Überschrift oder Seitenzahl).
`

const EXTRACT_SYSTEM = `\
Du überträgst eine alte Prüfung (Altklausur) mit offizieller Lösung in einen Prüfungstrainer. \
Du schreibst ab, du erfindest nichts: Aufgabentexte und Lösungen werden wörtlich übernommen.

Du bekommst das PDF und zusätzlich seinen Text. Im Text steht alles, was im PDF rot gedruckt ist, \
in ⟦…⟧ – das ist die offizielle Lösung. Alles andere ist die Aufgabenstellung. Ist nichts markiert, \
erkenne die Lösung am Layout (andere Farbe, Handschrift, Abschnitt „Lösungen“ am Ende o. Ä.).

Aufteilung:
- Jede Aufgabe bzw. Teilaufgabe mit eigener Punktzahl wird eine eigene Frage (z. B. 2.1, 2.2 \
oder 7a, 7b). "number" ist die Nummer aus der Klausur ohne Leerzeichen ("4.1", "7b").
- "heading" ist die Überschrift aus der Klausur, bei Teilaufgaben mit der Überschrift der \
Hauptaufgabe davor, z. B. "Aufgabe 11: Vertragslehre – a)" oder \
"Aufgabe 4: Fallbeispiel „Hotel Alpenstern“ – 4.1 Zielgrössen". Sie wird über der Frage \
angezeigt und gehört nicht zusätzlich in "question".
- Gehört eine Ausgangslage oder ein Fallbeispiel zu mehreren Teilaufgaben, steht sie vollständig \
am Anfang jeder dieser Fragen.
- Deckblatt, Punktetabelle, Kopf- und Fußzeilen und Hinweise wie „Lösung“ weglassen.

"question": der vollständige Aufgabentext, wörtlich, ohne jede Lösung. Silbentrennungen am \
Zeilenende zusammenfügen. Tabellen als Markdown-Tabelle, in die der Prüfling schreiben würde \
(Lösungsspalten leer lassen; die leeren Zellen werden in der Prüfung zu Eingabefeldern). Formeln in LaTeX ($...$). Verweist die Aufgabe auf eine Abbildung, \
beschreibe sie knapp in eckigen Klammern, z. B. „[Abbildung: Angebots- und Nachfragekurve …]“.

"kind":
- "zuordnung" für alles, was aus festen Antworten gewählt wird und je Zeile bewertet wird: \
Ankreuzen von Aussagen („Kreuzen Sie alle zutreffenden Aussagen an“), Unterstreichen \
(„tiefer/höher“), Zuordnen von Begriffen, Tabellen mit Auswahl wie „VR, GV oder RS“. \
Jede Zeile bzw. Aussage ist ein Eintrag in "items": "text" ist die Aussage (beim Unterstreichen \
mit „…“ an der Stelle der Auswahl), "choices" die Auswahlmöglichkeiten, "correct_index" die \
richtige. Beim Ankreuzen ist "choices" immer ["zutreffend", "nicht zutreffend"]. Beim Zuordnen \
von Begriffen a–f sind die choices die Begriffe mit Buchstaben, z. B. "a) Produktivität". \
Die Aussagen selbst gehören nicht zusätzlich in "question".
- "mc": klassisches Multiple Choice mit genau einer richtigen Antwort aus "options" \
(so viele Optionen wie in der Klausur), "correct_index" zeigt auf sie.
- "frei": alles andere (Erklären, Nennen, Berechnen, Tabellen mit freien Einträgen).

"answer": die offizielle Lösung wörtlich, inklusive Punkteangaben wie „(1 P.)“ und Hinweisen \
wie „Individuelle Antworten“. Tabellenlösungen als Markdown-Tabelle mit denselben Zeilen und \
Spalten wie die Tabelle der Frage, mehrere Punkte in einer Zelle mit „<br>“ trennen. Bei "mc" und "zuordnung" \
darf "answer" leer bleiben.

"points": Punktzahl der Frage laut Klausur. "page": Seite im PDF, auf der die Aufgabe beginnt.
"has_solution": false, wenn die Klausur zu dieser Aufgabe keine Lösung enthält. Dann bleibt \
"answer" leer und bei "mc"/"zuordnung" ist der jeweilige "correct_index" -1 – nicht selbst lösen.
"minutes" (oberste Ebene): Prüfungszeit in Minuten laut Deckblatt, 0 wenn nicht angegeben.
Unbenutzte Felder: "options" [] und "correct_index" -1 außer bei "mc", "items" [] außer bei \
"zuordnung".
`

const GRADE_SYSTEM = `\
Du bewertest eine Freitextantwort in einer Probeprüfung. Die Höchstpunktzahl steht in \
<max_punkte>; vergib 0 bis zu dieser Zahl, halbe Punkte sind erlaubt.

- Enthält die Musterlösung ein Punkteschema (z. B. „(1 P.)“, „je 2 P.“, „4 x 2 P.“), bewerte \
danach. Sonst gilt: volle Punktzahl, wenn alle Kernpunkte der Musterlösung korrekt genannt sind \
(Formulierung egal), anteilig weniger für fehlende oder ungenaue Kernpunkte, 0 für falsche, \
leere oder themenfremde Antworten.
- Steht in der Musterlösung „Individuelle Antworten“, „Mögliche Überlegungen“ oder eine Liste \
mit mehr Punkten als verlangt, sind das Beispiele: andere fachlich richtige Antworten zählen \
genauso.
- Verlangt die Frage eine Anzahl („Nennen Sie drei …“), werden höchstens so viele Nennungen \
gewertet, in der Reihenfolge der Antwort.

Bewerte fachlich und fair wie ein Prüfer. Das Feedback richtet sich direkt an den Prüfling \
(du-Form), ist kurz und nennt konkret, was gefehlt hat oder falsch war. Antworte in der \
Sprache der Frage.
`

export function makeClient(apiKey: string): Anthropic {
  if (!apiKey) throw new AIError('Kein API-Key hinterlegt. Trage ihn unter Einstellungen ein.', true)
  return new Anthropic({ apiKey })
}

/** Prüft einen Key mit einer kostenlosen Abfrage des Modells. Wirft bei ungültigem Key;
 *  gibt eine Warnung zurück, wenn die Prüfung aus anderen Gründen nicht möglich war. */
export async function checkKey(apiKey: string, model: string): Promise<string | null> {
  try {
    await new Anthropic({ apiKey, maxRetries: 0, timeout: 15_000 }).models.retrieve(model)
    return null
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AIError('Der API-Key ist ungültig.')
    if (e instanceof Anthropic.PermissionDeniedError) throw new AIError('Der API-Key hat keine Berechtigung für die API.')
    if (e instanceof Anthropic.NotFoundError) return `Key gespeichert, aber das Modell „${model}“ ist unbekannt – prüfe es unten.`
    if (e instanceof Anthropic.APIConnectionError) return 'Key gespeichert, konnte aber nicht geprüft werden (keine Verbindung).'
    if (e instanceof Anthropic.APIError) return `Key gespeichert, die Prüfung meldete aber: ${e.message}`
    throw e
  }
}

async function call(
  client: Anthropic, model: string, system: string, content: Anthropic.Beta.BetaContentBlockParam[],
  schema: Record<string, unknown>, maxTokens: number,
): Promise<unknown> {
  let msg: Anthropic.Beta.BetaMessage
  try {
    const stream = client.beta.messages.stream({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
    })
    msg = await stream.finalMessage()
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AIError('API-Key ungültig.', true)
    if (e instanceof Anthropic.PermissionDeniedError) throw new AIError('Der API-Key hat keine Berechtigung für dieses Modell.', true)
    if (e instanceof Anthropic.RateLimitError) throw new AIError('Rate-Limit erreicht. Bitte später erneut versuchen.')
    if (e instanceof Anthropic.APIConnectionError) throw new AIError('Keine Verbindung zur Claude API.', true)
    if (e instanceof Anthropic.APIError) throw new AIError(`API-Fehler ${e.status ?? ''}: ${e.message}`)
    throw e
  }

  if (msg.stop_reason === 'refusal') throw new AIError('Die Anfrage wurde vom Modell abgelehnt.')
  if (msg.stop_reason === 'max_tokens') throw new AIError('Antwort wurde abgeschnitten (max_tokens erreicht).')

  // Nach einem Modellwechsel zählt nur der Text des Ersatzmodells
  let text = ''
  for (const block of msg.content) {
    if (block.type === 'fallback') text = ''
    else if (block.type === 'text') text += block.text
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new AIError('Antwort der KI war kein gültiges JSON.')
  }
}

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw)
  if (!r.success) throw new AIError(`Unerwartetes Antwortformat: ${r.error.message}`)
  return r.data
}

function pdfBlock(data: Uint8Array): Anthropic.Beta.BetaContentBlockParam {
  return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(data).toString('base64') } }
}

export async function generateQuestions(
  client: Anthropic, model: string, section: Section, count: number, kinds: Kind[],
): Promise<Question[]> {
  const only = kinds.length === 1 ? kinds[0] : null
  const kindsText = only === 'mc'
    ? 'nur Multiple-Choice-Fragen (kind "mc")'
    : only === 'frei'
      ? 'nur Freitextfragen (kind "frei")'
      : 'eine Mischung aus Multiple-Choice- ("mc") und Freitextfragen ("frei")'

  let instruction = `Erstelle bis zu ${count} Prüfungsfragen zu diesem Material, ${kindsText}. ` +
    `Quelle: ${basename(section.path)} (${section.label}).`
  let content: Anthropic.Beta.BetaContentBlockParam[]
  if (section.kind === 'pdf') {
    const data = await pdfExcerpt(section.path, section.pages)
    const offset = section.pages[0]
    instruction += ` Das PDF ist ein Auszug: Seite 1 des Auszugs ist Seite ${offset + 1} des Originals. ` +
      `Gib in "location" die Originalseitenzahl an (z. B. "S. ${offset + 2}").`
    content = [pdfBlock(data), { type: 'text', text: instruction }]
  } else {
    content = [{ type: 'text', text: `<material>\n${section.text}\n</material>\n\n${instruction}` }]
  }

  const raw = await call(client, model, GENERATE_SYSTEM, content, GENERATE_SCHEMA, 32000)
  const generated = parse(GeneratedSet, raw).questions

  const questions: Question[] = []
  for (const g of generated) {
    if (!kinds.includes(g.kind as Kind)) continue
    const mc = g.kind === 'mc'
    // unbrauchbare MC-Frage verwerfen
    if (mc && !(g.options.length >= 2 && g.correct_index >= 0 && g.correct_index < g.options.length)) continue
    questions.push(emptyQuestion({
      kind: g.kind as Kind, text: g.question, options: mc ? g.options : [], correct_index: mc ? g.correct_index : -1,
      answer: g.answer, explanation: g.explanation, difficulty: Math.min(3, Math.max(1, g.difficulty)),
      subject_id: section.subject_id, source_path: section.path, source_loc: g.location || section.label,
      origin: 'ki', approved: false,
    }))
  }
  return questions
}

export interface ExtractedExam {
  questions: Question[]
  unsolved: number // Aufgaben ohne (vollständige) Lösung
  minutes: number // Prüfungszeit laut Deckblatt, 0 = unbekannt
}

/** Übernimmt die Aufgaben einer Altklausur wörtlich. */
export async function extractExam(client: Anthropic, model: string, section: Section): Promise<ExtractedExam> {
  const data = await pdfExcerpt(section.path, section.pages)
  const [text, redChars] = await markedText(section.path, section.pages)
  const offset = section.pages[0]
  const hint = redChars ? '' : '\nIm Text ist nichts rot markiert – erkenne die Lösungen am Layout oder setze has_solution auf false.'
  const instruction = `Übertrage alle Aufgaben dieser Altklausur (${basename(section.path)}). Seite 1 des PDFs ist ` +
    `Seite ${offset + 1} des Originals; gib in "page" die Originalseite an.${hint}\n\n<text>\n${text}\n</text>`
  const raw = await call(client, model, EXTRACT_SYSTEM, [pdfBlock(data), { type: 'text', text: instruction }], EXAM_SCHEMA, 64000)
  const exam = parse(ExamSet, raw)

  const questions: Question[] = []
  let unsolved = 0
  for (const t of exam.tasks) {
    let qtext = t.question.trim()
    if (t.heading.trim()) qtext = `**${t.heading.trim()}**\n\n${qtext}`
    const q = emptyQuestion({
      kind: t.kind, text: qtext, answer: t.answer.trim(), points: Math.max(0, t.points),
      subject_id: section.subject_id, source_path: section.path, source_loc: `Aufgabe ${t.number}, S. ${t.page}`,
      origin: 'klausur', approved: false, ext_key: examKey(section.subject_id, section.path, t.number),
    })
    let solved: boolean
    if (t.kind === 'mc') {
      q.options = t.options
      q.correct_index = t.correct_index >= 0 && t.correct_index < t.options.length ? t.correct_index : -1
      q.answer = q.answer || (q.correct_index >= 0 ? t.options[q.correct_index] : '')
      solved = q.correct_index >= 0
    } else if (t.kind === 'zuordnung') {
      // Zeilennummern wie „1:“ ergänzt die Anzeige selbst
      q.items = t.items
        .filter((i) => i.choices.length)
        .map((i) => ({
          text: i.text.replace(/^\s*\d+\s*[.:)]\s+/, ''), choices: i.choices,
          correct: i.correct_index >= 0 && i.correct_index < i.choices.length ? i.correct_index : -1,
        }))
      solved = q.items.length > 0 && q.items.every((i) => i.correct >= 0)
    } else {
      solved = Boolean(q.answer)
    }
    if (!(t.has_solution && solved)) {
      unsolved++
      q.explanation = 'Die Altklausur enthält zu dieser Aufgabe keine (vollständige) Lösung.'
    }
    questions.push(q)
  }
  return { questions, unsolved, minutes: Math.max(0, exam.minutes) }
}

export async function gradeAnswer(client: Anthropic, model: string, q: Question, userAnswer: string): Promise<Grading> {
  if (!userAnswer.trim()) return { points: 0, feedback: 'Keine Antwort abgegeben.' }
  const max = maxPoints(q)
  const text = `<frage>\n${q.text}\n</frage>\n<max_punkte>${max}</max_punkte>\n` +
    `<musterloesung>\n${q.answer}\n</musterloesung>\n` +
    `<erlaeuterung>\n${q.explanation}\n</erlaeuterung>\n` +
    `<antwort_pruefling>\n${userAnswer}\n</antwort_pruefling>`
  const raw = await call(client, model, GRADE_SYSTEM, [{ type: 'text', text }], GRADE_SCHEMA, 8000)
  const g = parse(GradingSchema, raw)
  return { points: Math.min(max, Math.max(0, Math.round(g.points * 2) / 2)), feedback: g.feedback }
}
