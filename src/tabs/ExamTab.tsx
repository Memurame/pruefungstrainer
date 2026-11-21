// Tab „Prüfung“: Probeprüfung zusammenstellen, durchführen und auswerten.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  comparisonMarkdown, fillTable, gradeFor, itemsMarkdown, KIND_LABEL, maxPoints, num, pickQuestions, questionTitle,
  shuffle, sourceText, splitTable, type Table, tableMarkdown,
} from '../../shared/logic'
import type { Kind, PracticeSet, Question, Subject } from '../../shared/types'
import { useDialogs } from '../components/dialogs'
import { Markdown } from '../components/Markdown'
import { Badge, Button, Check, Empty, NumberInput, Panel, ProgressBar, Select } from '../components/ui'
import { api, useApp } from '../state'

// Antwort je Frage: MC Index, Freitext Text, Zuordnung ein Index je Zeile (-1 = offen)
type Answer = number | string | number[] | null

function answered(a: Answer): boolean {
  if (Array.isArray(a)) return a.every((i) => i >= 0)
  return a !== null && a !== ''
}

interface Result {
  q: Question
  answer: Answer
  points: number
  feedback: string
  by: 'auto' | 'ki' | 'selbst' | 'offen'
  attemptId: number | null
}

type Phase = 'setup' | 'run' | 'grading' | 'result'

// --- Eingabe einer Tabelle mit leeren Zellen ----------------------------

function FillTable({ table, value, onChange }: { table: Table; value: string | null; onChange: (md: string | null) => void }) {
  // Eigener Zustand, damit beim Tippen nichts abgeschnitten wird; gespeichert wird bereinigt
  const [cells, setCells] = useState<string[][]>(() => {
    const saved = value ? splitTable(value)?.[1] : null
    const ok = saved && saved.rows.length === table.rows.length
    return table.rows.map((row, i) => row.map((given, j) => (given ? given : ok ? (saved.rows[i][j] ?? '').replace(/<br>/g, '\n') : '')))
  })
  const fillCols = table.header.map((_, j) => table.rows.some((row) => !row[j]))

  const update = (i: number, j: number, text: string) => {
    const next = cells.map((row, a) => row.map((c, b) => (a === i && b === j ? text : c)))
    setCells(next)
    const rows = next.map((row, a) => row.map((c, b) => (table.rows[a][b] ? c : c.trim())))
    // Nur ausgefüllte (nicht vorgegebene) Zellen zählen als Antwort
    const filled = rows.some((row, a) => row.some((c, b) => !table.rows[a][b] && c))
    onChange(filled ? tableMarkdown({ header: table.header, rows }) : null)
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {table.header.map((h, j) => (
              <th key={j} className={`border border-line bg-surface-2 px-2 py-1.5 text-left font-semibold ${fillCols[j] ? 'min-w-56' : ''}`}>
                <Markdown text={h} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i}>
              {row.map((given, j) =>
                given ? (
                  <td key={j} className="border border-line bg-surface-2/60 px-2 py-1.5 align-top">
                    <Markdown text={given} />
                  </td>
                ) : (
                  <td key={j} className="border border-line p-0 align-top">
                    <textarea
                      className="field-sizing-content block min-h-14 w-full resize-none border-0 bg-transparent px-2 py-1.5 text-[13px] leading-relaxed"
                      placeholder="…"
                      value={cells[i][j]}
                      onChange={(e) => update(i, j, e.target.value)}
                    />
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// --- Tab ----------------------------------------------------------------

export function ExamTab({ active }: { active: boolean }) {
  const app = useApp()
  const dialogs = useDialogs()
  const [phase, setPhase] = useState<Phase>('setup')

  // Einrichtung
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const known = useRef<Set<number>>(new Set())
  const [allQuestions, setAllQuestions] = useState<Question[]>([])
  const [sets, setSets] = useState<PracticeSet[]>([])
  const [setSubjectMap, setSetSubjectMap] = useState<Record<number, number[]>>({})
  const [setIds, setSetIds] = useState<Record<number, number[]>>({})
  const [setId, setSetId] = useState<number | null>(null)
  const [count, setCount] = useState(20)
  const [minutes, setMinutes] = useState(30)
  const [kinds, setKinds] = useState<Record<Kind, boolean>>({ mc: true, frei: true, zuordnung: true })
  const [onlyExam, setOnlyExam] = useState(false)
  const [onlyApproved, setOnlyApproved] = useState(true)
  const [preferWeak, setPreferWeak] = useState(false)

  // Durchführung
  const [questions, setQuestions] = useState<Question[]>([])
  const [answers, setAnswers] = useState<Answer[]>([])
  const [index, setIndex] = useState(0)
  const [remaining, setRemaining] = useState(0)
  const [limited, setLimited] = useState(false)
  const started = useRef(0)
  const [duration, setDuration] = useState(0)

  // Bewertung und Ergebnis
  const [gradeProg, setGradeProg] = useState({ done: 0, total: 0 })
  const [results, setResults] = useState<Result[]>([])
  const [current, setCurrent] = useState(0)
  const [override, setOverride] = useState(0)

  // --- Einrichtung ------------------------------------------------------

  useEffect(() => {
    if (phase !== 'setup' || !active) return
    void (async () => {
      const [ss, qs, ps, sm] = await Promise.all([api.subjects(), api.questions(), api.practiceSets(), api.setSubjects()])
      const ids: Record<number, number[]> = {}
      await Promise.all(ps.map(async (p) => (ids[p.id] = await api.setQuestionIds(p.id))))
      setSubjects(ss)
      // Neue Fächer sind angehakt, bei bekannten bleibt die Auswahl erhalten
      // (bekannte Fächer vorher festhalten: der Updater läuft erst beim nächsten Rendern)
      const before = known.current
      setChecked((c) => new Set(ss.filter((s) => c.has(s.id) || !before.has(s.id)).map((s) => s.id)))
      known.current = new Set(ss.map((s) => s.id))
      setAllQuestions(qs)
      setSets(ps)
      setSetSubjectMap(sm)
      setSetIds(ids)
    })()
  }, [app.version, phase, active])

  // Nur Übungssätze anbieten, die Fragen aus den angehakten Fächern enthalten
  const offeredSets = useMemo(
    () => sets.filter((s) => (setSubjectMap[s.id] ?? []).some((sid) => checked.has(sid))),
    [sets, setSubjectMap, checked],
  )
  useEffect(() => {
    if (setId != null && !offeredSets.some((s) => s.id === setId)) setSetId(null)
  }, [offeredSets, setId])

  const chooseSet = (id: number | null) => {
    setSetId(id)
    const s = sets.find((x) => x.id === id)
    if (s?.minutes) setMinutes(s.minutes)
  }

  const pool = useMemo(() => {
    if (setId != null) {
      // Übungssatz: alle Fragen in seiner Reihenfolge, auch nicht freigegebene
      const byId = new Map(allQuestions.map((q) => [q.id, q]))
      return (setIds[setId] ?? []).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
    }
    return allQuestions.filter(
      (q) =>
        q.subject_id != null && checked.has(q.subject_id) && kinds[q.kind] &&
        (q.approved || !onlyApproved) && (q.origin === 'klausur' || !onlyExam),
    )
  }, [setId, allQuestions, setIds, checked, kinds, onlyApproved, onlyExam])

  const start = async (chosen?: Question[]) => {
    let qs = chosen
    if (!qs) {
      if (!pool.length) {
        await dialogs.alert('Prüfung', 'Keine passenden Fragen. Generiere Fragen im Tab „Fächer“ und gib sie im Tab „Fragen“ frei.')
        return
      }
      qs = setId != null ? pool : pickQuestions(pool, count, await api.successRates(), preferWeak)
    }
    if (qs.some((q) => q.kind === 'frei') && !app.info?.hasApiKey) {
      await dialogs.alert('Freitext', 'Ohne API-Key werden Freitextantworten nicht automatisch bewertet. Du kannst sie nach der Prüfung selbst bewerten.')
    }
    setQuestions(qs)
    setAnswers(qs.map((q) => (q.kind === 'zuordnung' ? q.items.map(() => -1) : null)))
    setIndex(0)
    setRemaining(minutes * 60)
    setLimited(minutes > 0)
    started.current = Date.now()
    setPhase('run')
  }

  // --- Durchführung -----------------------------------------------------

  const setAnswer = (a: Answer) => setAnswers((list) => list.map((x, i) => (i === index ? a : x)))

  const submit = useCallback(
    async (confirm: boolean) => {
      const open = answers.filter((a) => !answered(a)).length
      if (confirm) {
        let msg = 'Prüfung abgeben?'
        if (open) msg += `\n\n${open} Frage(n) sind noch unbeantwortet.`
        if (!(await dialogs.confirm('Abgeben', msg, 'Abgeben'))) return
      }
      setLimited(false)
      setDuration((Date.now() - started.current) / 1000)

      const res: Result[] = questions.map((q, i) => {
        const a = answers[i]
        const r: Result = { q, answer: a, points: 0, feedback: '', by: 'offen', attemptId: null }
        if (q.kind === 'mc') {
          r.by = 'auto'
          r.points = a === q.correct_index ? maxPoints(q) : 0
        } else if (q.kind === 'zuordnung') {
          r.by = 'auto'
          const right = q.items.filter((item, n) => (a as number[])[n] === item.correct).length
          r.points = q.items.length ? Math.round((100 * maxPoints(q) * right) / q.items.length) / 100 : 0
        }
        return r
      })

      const toGrade = res.filter((r) => r.by === 'offen')
      let errors: string[] = []
      if (toGrade.length && app.info?.hasApiKey) {
        setGradeProg({ done: 0, total: toGrade.length })
        setPhase('grading')
        try {
          const out = await api.grade(toGrade.map((r) => ({ questionId: r.q.id!, answer: (r.answer as string | null) ?? '' })))
          out.results.forEach((g, i) => {
            if (g) Object.assign(toGrade[i], { points: g.points, feedback: g.feedback, by: 'ki' })
          })
          errors = out.errors
        } catch (e) {
          errors = [e instanceof Error ? e.message : String(e)]
        }
      }
      for (const r of res) {
        if (r.by === 'offen') {
          r.feedback = 'Nicht automatisch bewertet – vergleiche mit der Musterlösung und vergib die Punkte unten selbst.'
        }
        r.attemptId = await api.recordAttempt(r.q.id!, r.points, maxPoints(r.q))
      }
      setResults(res)
      setCurrent(0)
      setPhase('result')
      app.bump()
      if (errors.length) await dialogs.alert('Bewertung', `Einige Antworten konnten nicht bewertet werden:\n${errors.join('\n')}`)
    },
    [answers, questions, dialogs, app],
  )

  useEffect(() => api.onProgress((p) => p.job === 'grade' && setGradeProg({ done: p.done, total: p.total })), [])

  // Zeitlimit
  const submitRef = useRef(submit)
  submitRef.current = submit
  useEffect(() => {
    if (phase !== 'run' || !limited) return
    const t = window.setInterval(() => setRemaining((r) => r - 1), 1000)
    return () => window.clearInterval(t)
  }, [phase, limited])
  useEffect(() => {
    if (phase === 'run' && limited && remaining <= 0) {
      setLimited(false)
      void dialogs.alert('Zeit abgelaufen', 'Die Zeit ist um – die Prüfung wird abgegeben.').then(() => submitRef.current(false))
    }
  }, [remaining, phase, limited, dialogs])

  const abort = async () => {
    if (await dialogs.confirm('Abbrechen', 'Prüfung abbrechen? Antworten werden nicht gewertet.', 'Prüfung abbrechen', true)) {
      setLimited(false)
      setPhase('setup')
    }
  }

  // --- Ergebnis ---------------------------------------------------------

  const r = results[current]
  useEffect(() => setOverride(r?.points ?? 0), [r])

  const applyOverride = async () => {
    if (!r || r.attemptId == null) return
    const points = Math.min(maxPoints(r.q), Math.max(0, override))
    await api.updateAttempt(r.attemptId, points)
    setResults((list) =>
      list.map((x, i) =>
        i === current ? { ...x, points, by: 'selbst', feedback: x.feedback.startsWith('Nicht automatisch') ? 'Selbst bewertet.' : x.feedback } : x,
      ),
    )
    app.bump()
  }

  const retryWrong = async () => {
    const wrong = results.filter((x) => x.points < maxPoints(x.q)).map((x) => x.q)
    if (!wrong.length) {
      await dialogs.alert('Wiederholen', 'Alles richtig – nichts zu wiederholen!')
      return
    }
    await start(shuffle(wrong))
  }

  // --- Ansichten --------------------------------------------------------

  if (phase === 'setup') {
    const set = sets.find((s) => s.id === setId)
    const usesSet = setId != null
    return (
      <div className="h-full overflow-y-auto p-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          <h1 className="pt-2 text-xl font-semibold">Probeprüfung</h1>
          <Panel title="Fächer">
            <div className="grid max-h-56 grid-cols-2 gap-x-4 gap-y-2 overflow-y-auto p-3">
              {subjects.map((s) => (
                <Check
                  key={s.id}
                  label={s.name}
                  checked={checked.has(s.id)}
                  onChange={(v) =>
                    setChecked((c) => {
                      const next = new Set(c)
                      if (v) next.add(s.id)
                      else next.delete(s.id)
                      return next
                    })
                  }
                />
              ))}
              {!subjects.length && <p className="text-[13px] text-muted">Noch keine Fächer.</p>}
            </div>
          </Panel>
          <Panel>
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3 p-4 text-[13px]">
              <span className="text-muted">Übungssatz</span>
              <Select value={setId ?? ''} onChange={(e) => chooseSet(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Keiner – Fragen aus den Fächern mischen</option>
                {offeredSets.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.count} Fragen)</option>)}
              </Select>
              <span className="text-muted">Anzahl Fragen</span>
              <NumberInput value={count} min={1} max={200} onChange={setCount} disabled={usesSet} />
              <span className="text-muted">Zeitlimit (min)</span>
              <div className="flex items-center gap-2">
                <NumberInput value={minutes} max={600} onChange={setMinutes} />
                <span className="text-[12px] text-muted">{minutes ? '' : 'ohne Zeitlimit'}</span>
              </div>
              <span className="text-muted">Fragetypen</span>
              <div className="flex flex-wrap gap-4">
                <Check label="Multiple Choice" checked={kinds.mc} disabled={usesSet} onChange={(v) => setKinds((k) => ({ ...k, mc: v }))} />
                <Check label="Freitext" checked={kinds.frei} disabled={usesSet} onChange={(v) => setKinds((k) => ({ ...k, frei: v }))} />
                <Check label="Zuordnung / Ankreuzen" checked={kinds.zuordnung} disabled={usesSet} onChange={(v) => setKinds((k) => ({ ...k, zuordnung: v }))} />
              </div>
              <span />
              <div className="flex flex-col gap-2">
                <Check label="Nur Aufgaben aus Altklausuren" checked={onlyExam} disabled={usesSet} onChange={setOnlyExam} />
                <Check label="Nur freigegebene Fragen" checked={onlyApproved} disabled={usesSet} onChange={setOnlyApproved} />
                <Check label="Schwächen bevorzugen (oft falsch beantwortete Fragen häufiger)" checked={preferWeak} disabled={usesSet} onChange={setPreferWeak} />
              </div>
            </div>
          </Panel>
          <p className="text-[13px] text-muted">
            {set
              ? `${pool.length} Fragen, ${num(pool.reduce((s, q) => s + maxPoints(q), 0))} Punkte. Der Übungssatz wird vollständig in seiner Reihenfolge gestellt.`
              : `${pool.length} passende Fragen verfügbar.`}
          </p>
          <Button variant="primary" className="py-2.5 text-[14px]" onClick={() => start()}>Prüfung starten</Button>
        </div>
      </div>
    )
  }

  if (phase === 'run') {
    const q = questions[index]
    const ans = answers[index]
    const table = fillTable(q)
    const mm = String(Math.floor(Math.max(remaining, 0) / 60)).padStart(2, '0')
    const ss = String(Math.max(remaining, 0) % 60).padStart(2, '0')
    return (
      <div className="flex h-full flex-col gap-3 p-3">
        <div className="flex items-center gap-3">
          <div className="flex-1 text-[13px]">
            <span className="font-semibold">Frage {index + 1} von {questions.length}</span>
            <span className="text-muted"> · {q.subject} · {KIND_LABEL[q.kind]} ({num(maxPoints(q))} P.)</span>
          </div>
          {limited && <div className={`text-xl font-semibold tabular-nums ${remaining < 60 ? 'text-bad' : ''}`}>⏱ {mm}:{ss}</div>}
        </div>
        <div className="flex min-h-0 flex-1 gap-3">
          <Panel className="w-48 shrink-0">
            <ol className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {questions.map((x, i) => (
                <li
                  key={i}
                  onClick={() => setIndex(i)}
                  className={`flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] ${
                    i === index ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-hover'
                  }`}
                >
                  <span className="w-6 text-right tabular-nums text-muted">{i + 1}.</span>
                  <span className="flex-1 truncate">{KIND_LABEL[x.kind]}</span>
                  {answered(answers[i]) && <span className="text-ok">✓</span>}
                </li>
              ))}
            </ol>
          </Panel>
          <Panel className="min-w-0 flex-1">
            <div className="min-h-0 flex-1 overflow-y-auto p-5" key={index}>
              <Markdown text={table ? `${table[0]}\n\n${table[2]}` : q.text} className="text-[14px]" />
              <div className="mt-5">
                {q.kind === 'mc' && (
                  <div className="flex flex-col gap-2">
                    {q.options.map((opt, i) => (
                      <label
                        key={i}
                        className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-[14px] ${
                          ans === i ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover'
                        }`}
                      >
                        <input type="radio" name={`q${index}`} className="mt-1 accent-[var(--accent)]" checked={ans === i} onChange={() => setAnswer(i)} />
                        <span className="font-medium">{String.fromCharCode(65 + i)})</span>
                        <Markdown text={opt} className="flex-1" />
                      </label>
                    ))}
                  </div>
                )}
                {q.kind === 'zuordnung' && (
                  <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
                    {q.items.map((item, n) => (
                      <div key={n} className="flex items-start gap-3 px-3 py-2.5 text-[14px]">
                        <span className="w-6 text-right tabular-nums text-muted">{n + 1}.</span>
                        <Markdown text={item.text} className="flex-1" />
                        <Select
                          value={(ans as number[])[n]}
                          onChange={(e) => setAnswer((ans as number[]).map((x, k) => (k === n ? Number(e.target.value) : x)))}
                          className="max-w-64"
                        >
                          <option value={-1}>–</option>
                          {item.choices.map((c, k) => <option key={k} value={k}>{c}</option>)}
                        </Select>
                      </div>
                    ))}
                  </div>
                )}
                {q.kind === 'frei' && table && (
                  <FillTable table={table[1]} value={ans as string | null} onChange={setAnswer} />
                )}
                {q.kind === 'frei' && !table && (
                  <textarea
                    autoFocus
                    className="min-h-48 w-full rounded-lg border border-line px-3 py-2.5 text-[14px] leading-relaxed"
                    placeholder="Deine Antwort …"
                    value={(ans as string | null) ?? ''}
                    onChange={(e) => setAnswer(e.target.value)}
                  />
                )}
              </div>
            </div>
            <div className="flex gap-1.5 border-t border-line p-2">
              <Button variant="danger" onClick={abort}>Abbrechen</Button>
              <Button className="ml-auto" onClick={() => setIndex(index - 1)} disabled={index === 0}>◀ Zurück</Button>
              <Button onClick={() => setIndex(index + 1)} disabled={index === questions.length - 1}>Weiter ▶</Button>
              <Button variant="primary" onClick={() => submit(true)}>Abgeben</Button>
            </div>
          </Panel>
        </div>
      </div>
    )
  }

  if (phase === 'grading') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <p className="text-[14px]">Freitextantworten werden bewertet … ({gradeProg.done} von {gradeProg.total})</p>
        <div className="w-80"><ProgressBar done={gradeProg.done} total={gradeProg.total} /></div>
      </div>
    )
  }

  // Ergebnis
  const got = results.reduce((s, x) => s + x.points, 0)
  const total = results.reduce((s, x) => s + maxPoints(x.q), 0)
  const pct = total ? (100 * got) / total : 0
  const openN = results.filter((x) => x.by === 'offen').length
  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-1">
        <h1 className="text-xl font-semibold">
          {num(got)} / {num(total)} Punkte ({Math.round(pct)} %) – Note {gradeFor(pct)}
        </h1>
        <span className="text-[13px] text-muted">Bearbeitungszeit: {Math.floor(duration / 60)} min {Math.floor(duration % 60)} s</span>
        {openN > 0 && <Badge tone="warn">{openN} Freitextantwort(en) noch selbst bewerten</Badge>}
      </div>
      <div className="flex min-h-0 flex-1 gap-3">
        <Panel className="w-[42%] shrink-0">
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead className="sticky top-0 bg-surface-2 text-left text-[12px] text-muted">
                <tr>
                  <th className="w-px px-2 py-1.5 font-medium">Nr.</th>
                  <th className="w-px px-2 py-1.5 font-medium">Punkte</th>
                  <th className="px-2 py-1.5 font-medium">Frage</th>
                </tr>
              </thead>
              <tbody>
                {results.map((x, i) => {
                  const full = x.points >= maxPoints(x.q)
                  const mark = x.by === 'offen' ? '?' : full ? '✓' : x.points > 0 ? '◐' : '✗'
                  const tone = x.by === 'offen' ? 'text-warn' : full ? 'text-ok' : x.points > 0 ? 'text-warn' : 'text-bad'
                  return (
                    <tr
                      key={i}
                      onClick={() => setCurrent(i)}
                      className={`cursor-default border-b border-line/60 ${i === current ? 'bg-accent-soft' : 'hover:bg-hover'}`}
                    >
                      <td className="px-2 py-1.5 text-muted tabular-nums">{i + 1}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">
                        <span className={tone}>{mark}</span> {num(x.points)}/{num(maxPoints(x.q))}
                      </td>
                      <td className="max-w-0 truncate px-2 py-1.5" title={`${KIND_LABEL[x.q.kind]} · ${x.q.subject}`}>{questionTitle(x.q)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel className="min-w-0 flex-1">
          <div className="min-h-0 flex-1 overflow-y-auto p-5">{r ? <Markdown text={detailMarkdown(r)} /> : <Empty>–</Empty>}</div>
          {r?.q.kind === 'frei' && (
            <div className="flex items-center gap-2 border-t border-line p-2 text-[13px]">
              Bewertung anpassen:
              <NumberInput value={override} max={maxPoints(r.q)} step={0.5} onChange={setOverride} />
              <span className="text-muted">von {num(maxPoints(r.q))} Punkten</span>
              <Button onClick={applyOverride}>Punkte übernehmen</Button>
            </div>
          )}
        </Panel>
      </div>
      <div className="flex gap-1.5">
        <Button onClick={() => r && api.openSource(r.q.source_path)} disabled={!r?.q.source_path}>Quelle öffnen</Button>
        <Button className="ml-auto" onClick={retryWrong}>Falsche Fragen wiederholen</Button>
        <Button variant="primary" onClick={() => setPhase('setup')}>Neue Prüfung</Button>
      </div>
    </div>
  )
}

function detailMarkdown(r: Result): string {
  const q = r.q
  let md = `### Frage\n\n${q.text}\n\n`
  if (q.kind === 'mc') {
    q.options.forEach((opt, i) => {
      const tags = []
      if (i === q.correct_index) tags.push('**✓ richtig**')
      if (i === r.answer) tags.push('*← deine Antwort*')
      md += `${String.fromCharCode(65 + i)}) ${opt} ${tags.join(' ')}\n\n`
    })
    if (r.answer === null) md += '*Nicht beantwortet.*\n\n'
  } else if (q.kind === 'zuordnung') {
    md += itemsMarkdown(q, r.answer as number[])
    if (q.answer) md += `### Musterlösung\n\n${q.answer}\n\n`
  } else {
    const compared = comparisonMarkdown(q, (r.answer as string | null) ?? '')
    if (compared) {
      const parts = fillTable(q)!
      md = `### Frage\n\n${parts[0]}\n\n${parts[2]}\n\n${compared}`
    } else {
      const answer = ((r.answer as string | null) ?? '').trim() || '*(keine Antwort)*'
      md += `### Deine Antwort\n\n${answer}\n\n### Musterlösung\n\n${q.answer}\n\n`
    }
  }
  if (q.kind === 'frei' && r.feedback) md += `### Bewertung (${num(r.points)}/${num(maxPoints(q))})\n\n${r.feedback}\n\n`
  if (q.explanation) md += `### Erläuterung\n\n${q.explanation}\n\n`
  if (q.source_path) md += `*Quelle: ${sourceText(q)}*\n`
  return md
}
