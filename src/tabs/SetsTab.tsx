// Tab „Übungssätze“: feste Zusammenstellungen von Fragen, z. B. eine Altklausur.

import { useEffect, useState } from 'react'
import { KIND_LABEL, maxPoints, num, questionMarkdown, questionTitle } from '../../shared/logic'
import type { PracticeSet, Question } from '../../shared/types'
import { useDialogs } from '../components/dialogs'
import { Markdown } from '../components/Markdown'
import { Button, Empty, NumberInput, Panel, selectRows } from '../components/ui'
import { api, useApp } from '../state'

export function SetsTab() {
  const app = useApp()
  const dialogs = useDialogs()
  const [sets, setSets] = useState<PracticeSet[]>([])
  const [current, setCurrent] = useState<number | null>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const [minutes, setMinutes] = useState(0)

  useEffect(() => {
    void api.practiceSets().then((list) => {
      setSets(list)
      setCurrent((cur) => (cur != null && list.some((s) => s.id === cur) ? cur : (list[0]?.id ?? null)))
    })
  }, [app.version])

  useEffect(() => {
    if (current == null) {
      setQuestions([])
      return
    }
    void Promise.all([api.questions(), api.setQuestionIds(current)]).then(([all, ids]) => {
      const byId = new Map(all.map((q) => [q.id, q]))
      setQuestions(ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])))
    })
  }, [current, app.version])

  const set = sets.find((s) => s.id === current)
  useEffect(() => setMinutes(set?.minutes ?? 0), [set?.id, set?.minutes])
  useEffect(() => setSelected([]), [current])

  const saveMinutes = async (value: number) => {
    setMinutes(value)
    if (current != null) {
      await api.setPracticeMinutes(current, value)
      app.bump()
    }
  }

  const newSet = async () => {
    const name = await dialogs.prompt('Neuer Übungssatz', 'Name des Übungssatzes:')
    if (!name) return
    const id = await app.guard(() => api.addPracticeSet(name), 'Übungssatz')
    if (id != null) {
      setCurrent(id)
      app.bump()
    }
  }

  const renameSet = async () => {
    if (!set) return
    const name = await dialogs.prompt('Übungssatz umbenennen', 'Neuer Name:', set.name)
    if (!name) return
    if ((await app.guard(async () => (await api.renamePracticeSet(set.id, name), true), 'Übungssatz')) !== undefined) app.bump()
  }

  const deleteSet = async () => {
    if (!set) return
    const ok = await dialogs.confirm('Übungssatz löschen', `„${set.name}“ löschen?\n\nDie Fragen selbst und deine Ergebnisse bleiben erhalten.`, 'Löschen', true)
    if (ok) {
      await api.deletePracticeSet(set.id)
      app.bump()
    }
  }

  const reorder = async (ids: number[], select: number[]) => {
    if (current == null) return
    await api.reorderSet(current, ids)
    setSelected(select)
    app.bump()
  }

  const move = (step: number) => {
    if (selected.length !== 1) return
    const i = selected[0]
    const j = i + step
    if (j < 0 || j >= questions.length) return
    const ids = questions.map((q) => q.id!)
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    void reorder(ids, [j])
  }

  const removeSelected = () => {
    if (!selected.length) return
    void reorder(questions.filter((_, n) => !selected.includes(n)).map((q) => q.id!), [])
  }

  const totalPoints = questions.reduce((sum, q) => sum + maxPoints(q), 0)

  return (
    <div className="flex h-full gap-3 p-3">
      <Panel title="Übungssätze" className="w-72 shrink-0">
        <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {sets.map((s) => (
            <li
              key={s.id}
              onClick={() => setCurrent(s.id)}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] ${
                s.id === current ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-hover'
              }`}
            >
              <span className="min-w-0 flex-1 truncate" title={s.source_path ?? undefined}>{s.name}</span>
              <span className="text-[12px] text-muted tabular-nums">{s.count}</span>
            </li>
          ))}
          {!sets.length && <li className="px-2.5 py-2 text-[13px] text-muted">Noch keine Übungssätze.</li>}
        </ul>
        <div className="flex flex-col gap-1.5 border-t border-line p-2">
          <Button variant="primary" onClick={newSet}>Neuer Übungssatz …</Button>
          <div className="grid grid-cols-2 gap-1.5">
            <Button onClick={renameSet} disabled={!set}>Umbenennen …</Button>
            <Button variant="danger" onClick={deleteSet} disabled={!set}>Löschen</Button>
          </div>
        </div>
      </Panel>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <Panel
          className="min-h-0 flex-[3]"
          title={set ? set.name : 'Kein Übungssatz'}
          actions={
            set && (
              <label className="flex items-center gap-2 text-[12px] text-muted">
                Zeitlimit (min, 0 = keins)
                <NumberInput value={minutes} max={600} onChange={saveMinutes} className="w-20" />
              </label>
            )
          }
        >
          {!set ? (
            <Empty>Lege links einen Übungssatz an. Altklausuren werden automatisch zu Übungssätzen.</Empty>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto select-none">
              <table className="w-full border-collapse text-[13px]">
                <thead className="sticky top-0 bg-surface-2 text-left text-[12px] text-muted">
                  <tr>
                    <th className="w-px px-2 py-1.5 font-medium">Nr.</th>
                    <th className="w-px px-2 py-1.5 font-medium">Typ</th>
                    <th className="w-px px-2 py-1.5 font-medium">Punkte</th>
                    <th className="w-px px-2 py-1.5 font-medium">Fach</th>
                    <th className="px-2 py-1.5 font-medium">Frage</th>
                  </tr>
                </thead>
                <tbody>
                  {questions.map((q, i) => (
                    <tr
                      key={q.id}
                      onClick={(e) => setSelected((s) => selectRows(s, i, e, s[0] ?? null))}
                      className={`cursor-default border-b border-line/60 ${selected.includes(i) ? 'bg-accent-soft' : 'hover:bg-hover'}`}
                    >
                      <td className="px-2 py-1.5 text-muted tabular-nums">{i + 1}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-muted">{KIND_LABEL[q.kind]}</td>
                      <td className="px-2 py-1.5 tabular-nums">{num(maxPoints(q))}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-muted">{q.subject}</td>
                      <td className="max-w-0 truncate px-2 py-1.5">{questionTitle(q)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!questions.length && <Empty>Fragen fügst du im Tab „Fragen“ mit „Zu Übungssatz …“ hinzu.</Empty>}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5 border-t border-line p-2">
            <Button onClick={() => move(-1)} disabled={selected.length !== 1}>▲ Nach oben</Button>
            <Button onClick={() => move(1)} disabled={selected.length !== 1}>▼ Nach unten</Button>
            <Button variant="danger" onClick={removeSelected} disabled={!selected.length}>Aus dem Satz entfernen</Button>
            <span className="ml-auto text-[12px] text-muted">{questions.length} Fragen, {num(totalPoints)} Punkte</span>
          </div>
        </Panel>
        <Panel title="Vorschau" className="min-h-0 flex-[2]">
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {selected.length ? <Markdown text={questionMarkdown(questions[selected[0]])} /> : <Empty>Wähle eine Frage aus.</Empty>}
          </div>
        </Panel>
      </div>
    </div>
  )
}
