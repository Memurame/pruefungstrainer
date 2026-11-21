// Frage anlegen oder bearbeiten.

import { useState } from 'react'
import { itemsFromText, itemsToText, sourceText } from '../../shared/logic'
import type { Kind, Question, Subject } from '../../shared/types'
import { Modal } from '../components/dialogs'
import { Button, Check, Input, NumberInput, Select } from '../components/ui'

const field = 'flex flex-col gap-1 text-[12px] font-medium text-muted'
const area = 'w-full rounded-md border border-line px-2.5 py-2 text-[13px] text-fg font-normal leading-relaxed'

export function QuestionDialog({ question, subjects, onSave, onClose }: {
  question: Question; subjects: Subject[]; onSave: (q: Question) => void; onClose: () => void
}) {
  const q = question
  const [kind, setKind] = useState<Kind>(q.kind)
  const [subjectId, setSubjectId] = useState<number>(q.subject_id ?? subjects[0]?.id)
  const [difficulty, setDifficulty] = useState(q.difficulty)
  const [points, setPoints] = useState(q.points)
  const [text, setText] = useState(q.text)
  const [options, setOptions] = useState<string[]>(() => {
    const o = [...q.options]
    while (o.length < 4) o.push('')
    return o
  })
  const [correct, setCorrect] = useState(q.correct_index)
  const [items, setItems] = useState(itemsToText(q.items))
  const [answer, setAnswer] = useState(q.answer)
  const [explanation, setExplanation] = useState(q.explanation)
  const [approved, setApproved] = useState(q.approved || q.id == null)
  const [error, setError] = useState('')

  const save = () => {
    const t = text.trim()
    if (!t) return setError('Bitte einen Fragetext eingeben.')
    const out: Question = {
      ...q, kind, text: t, subject_id: subjectId, difficulty, points,
      explanation: explanation.trim(), approved,
    }
    if (kind === 'mc') {
      const trimmed = options.map((o) => o.trim())
      const filled = trimmed.filter(Boolean)
      if (filled.length < 2 || correct < 0 || !trimmed[correct]) {
        return setError('Mindestens zwei Optionen ausfüllen und die richtige markieren.')
      }
      // Leere Optionen entfernen, Index nachziehen
      const idx = trimmed.slice(0, correct).filter(Boolean).length
      Object.assign(out, { options: filled, correct_index: idx, answer: filled[idx], items: [] })
    } else if (kind === 'zuordnung') {
      const parsed = itemsFromText(items)
      if (!parsed?.length) {
        return setError('Bitte mindestens eine Zeile im Format „Aussage :: Wahl A | *Wahl B“ eingeben, mit genau einem Stern je Zeile.')
      }
      Object.assign(out, { options: [], correct_index: -1, items: parsed })
    } else {
      if (!answer.trim()) return setError('Bitte eine Musterlösung eingeben – sie wird zur Bewertung gebraucht.')
      Object.assign(out, { options: [], correct_index: -1, items: [], answer: answer.trim() })
    }
    onSave(out)
  }

  return (
    <Modal
      title={q.id ? 'Frage bearbeiten' : 'Neue Frage'}
      onClose={onClose}
      width="max-w-3xl"
      footer={
        <>
          {error && <p className="mr-auto self-center text-[12px] text-bad">{error}</p>}
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" onClick={save}>Speichern</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <label className={field}>
            Typ
            <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              <option value="mc">Multiple Choice</option>
              <option value="frei">Freitext</option>
              <option value="zuordnung">Zuordnung / Ankreuzen</option>
            </Select>
          </label>
          <label className={field}>
            Fach
            <Select value={subjectId} onChange={(e) => setSubjectId(Number(e.target.value))}>
              {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </label>
          <label className={field}>
            Schwierigkeit
            <Select value={difficulty} onChange={(e) => setDifficulty(Number(e.target.value))}>
              <option value={1}>leicht</option>
              <option value={2}>mittel</option>
              <option value={3}>schwer</option>
            </Select>
          </label>
          <label className={field} title="0 = Standard (MC 1, Freitext 3, Zuordnung 1 je Zeile)">
            Punkte (0 = Standard)
            <NumberInput value={points} step={0.5} onChange={setPoints} className="w-full" />
          </label>
        </div>
        {q.source_path && <p className="text-[12px] text-muted">Quelle: {sourceText(q)}</p>}

        <label className={field}>
          Frage (Markdown möglich)
          <textarea className={area} rows={6} value={text} onChange={(e) => setText(e.target.value)} />
        </label>

        {kind === 'mc' && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-[12px] font-medium text-muted">Antwortoptionen (richtige markieren)</legend>
            {options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <label className="flex w-8 items-center gap-1 text-[13px]">
                  <input type="radio" name="correct" className="accent-[var(--accent)]" checked={correct === i} onChange={() => setCorrect(i)} />
                  {String.fromCharCode(65 + i)}
                </label>
                <Input className="flex-1" value={o} onChange={(e) => setOptions((os) => os.map((x, j) => (j === i ? e.target.value : x)))} />
              </div>
            ))}
            <Button variant="ghost" className="self-start" onClick={() => setOptions((os) => [...os, ''])}>+ Option</Button>
          </fieldset>
        )}

        {kind === 'zuordnung' && (
          <label className={field}>
            <span>
              Eine Zeile je Aussage: <code className="rounded bg-surface-2 px-1">Aussage :: Wahl A | *Wahl B</code> – der Stern markiert die richtige Wahl.
            </span>
            <textarea
              className={`${area} font-mono text-[12px]`}
              rows={7}
              value={items}
              placeholder="Typisch für EFQM ist das Prinzip der Selbstbewertung. :: *zutreffend | nicht zutreffend"
              onChange={(e) => setItems(e.target.value)}
            />
          </label>
        )}

        {kind === 'frei' && (
          <label className={field}>
            Musterlösung
            <textarea className={area} rows={6} value={answer} onChange={(e) => setAnswer(e.target.value)} />
          </label>
        )}

        <label className={field}>
          Erläuterung (optional)
          <textarea className={area} rows={3} value={explanation} onChange={(e) => setExplanation(e.target.value)} />
        </label>

        <Check label="Freigegeben (wird in Prüfungen verwendet)" checked={approved} onChange={setApproved} />
      </div>
    </Modal>
  )
}
