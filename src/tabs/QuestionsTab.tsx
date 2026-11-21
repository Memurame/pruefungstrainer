// Tab „Fragen“: generierte und eigene Fragen prüfen, bearbeiten, freigeben und zu Übungssätzen
// zusammenstellen.

import { useEffect, useMemo, useRef, useState } from 'react'
import { emptyQuestion, KIND_LABEL, ORIGIN_LABEL, questionMarkdown, questionTitle, sourceText } from '../../shared/logic'
import type { Question, Subject } from '../../shared/types'
import { useDialogs } from '../components/dialogs'
import { Markdown } from '../components/Markdown'
import { Button, Empty, Input, Panel, Select, selectRows } from '../components/ui'
import { api, useApp } from '../state'
import { QuestionDialog } from './QuestionDialog'

/** Fragt nach einem bestehenden oder neuen Übungssatz; gibt seine ID zurück. */
export async function chooseSet(dialogs: ReturnType<typeof useDialogs>, guard: ReturnType<typeof useApp>['guard']): Promise<number | null> {
  const sets = await api.practiceSets()
  const names = [...sets.map((s) => s.name), 'Neuer Übungssatz …']
  const i = await dialogs.choose('Zu Übungssatz hinzufügen', 'Übungssatz:', names)
  if (i == null) return null
  if (i < sets.length) return sets[i].id
  const name = await dialogs.prompt('Neuer Übungssatz', 'Name des Übungssatzes:')
  if (!name) return null
  return (await guard(() => api.addPracticeSet(name), 'Übungssatz')) ?? null
}

export function QuestionsTab() {
  const app = useApp()
  const dialogs = useDialogs()
  const [all, setAll] = useState<Question[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [subject, setSubject] = useState<number | 'all'>('all')
  const [status, setStatus] = useState<'all' | 'pending' | 'approved'>('all')
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [editing, setEditing] = useState<Question | null>(null)
  const anchor = useRef<number | null>(null)

  useEffect(() => {
    void Promise.all([api.questions(), api.subjects()]).then(([qs, ss]) => {
      setAll(qs)
      setSubjects(ss)
      setSubject((cur) => (cur === 'all' || ss.some((s) => s.id === cur) ? cur : 'all'))
    })
  }, [app.version])

  const shown = useMemo(() => {
    const needle = search.toLowerCase()
    return all.filter(
      (q) =>
        (subject === 'all' || q.subject_id === subject) &&
        (status === 'all' || (status === 'pending') !== q.approved) &&
        (!needle || q.text.toLowerCase().includes(needle) || q.source_path.toLowerCase().includes(needle)),
    )
  }, [all, subject, status, search])

  // Die Auswahl hängt an Frage-IDs, damit sie Filter und Neuladen übersteht
  const selected = shown.flatMap((q, i) => (q.id != null && selectedIds.includes(q.id) ? [i] : []))
  const sel = selected.map((i) => shown[i])
  const clickRow = (i: number, e: React.MouseEvent) => {
    setSelectedIds(selectRows(selected, i, e, anchor.current).map((j) => shown[j].id!))
    if (!e.shiftKey) anchor.current = i
  }
  const pending = all.filter((q) => !q.approved).length

  const save = async (q: Question) => {
    if (await app.guard(() => api.saveQuestion(q))) {
      setEditing(null)
      app.bump()
    }
  }

  const newQuestion = async () => {
    if (!subjects.length) {
      await dialogs.alert('Fach', 'Lege zuerst im Tab „Fächer“ ein Fach an.')
      return
    }
    setEditing(emptyQuestion({ kind: 'frei', origin: 'manuell', subject_id: subject === 'all' ? subjects[0].id : subject }))
  }

  const approve = async (ids: number[], value: boolean) => {
    await app.guard(() => api.setApproved(ids, value))
    app.bump()
  }

  const approveAll = async () => {
    if (await dialogs.confirm('Freigeben', `${shown.length} angezeigte Fragen freigeben?`, 'Freigeben')) {
      await approve(shown.map((q) => q.id!), true)
    }
  }

  const addToSet = async () => {
    if (!sel.length) {
      await dialogs.alert('Übungssatz', 'Markiere zuerst eine oder mehrere Fragen.')
      return
    }
    const setId = await chooseSet(dialogs, app.guard)
    if (setId != null) {
      await app.guard(() => api.addToSet(setId, sel.map((q) => q.id!)))
      app.bump()
      app.notify(`${sel.length} Frage(n) zum Übungssatz hinzugefügt.`)
    }
  }

  const remove = async () => {
    if (!sel.length) return
    let msg = `${sel.length} Frage(n) löschen?`
    if (sel.some((q) => q.origin === 'notiz')) {
      msg += '\n\nFragen aus Notizen kommen beim nächsten Einlesen wieder – entferne sie dafür in Obsidian.'
    }
    if (await dialogs.confirm('Löschen', msg, 'Löschen', true)) {
      await app.guard(() => api.deleteQuestions(sel.map((q) => q.id!)))
      setSelectedIds([])
      app.bump()
    }
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="flex gap-2">
        <Select value={subject} onChange={(e) => setSubject(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
          <option value="all">Alle Fächer</option>
          {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="all">Alle</option>
          <option value="pending">Nicht freigegeben</option>
          <option value="approved">Freigegeben</option>
        </Select>
        <Input className="flex-1" placeholder="Suchen …" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        <Panel className="min-w-0 flex-[3]">
          <div className="min-h-0 flex-1 overflow-auto select-none">
            <table className="w-full border-collapse text-[13px]">
              <thead className="sticky top-0 bg-surface-2 text-left text-[12px] text-muted">
                <tr>
                  <th className="w-px px-2 py-1.5 font-medium">✓</th>
                  <th className="w-px px-2 py-1.5 font-medium">Typ</th>
                  <th className="w-px px-2 py-1.5 font-medium">Fach</th>
                  <th className="px-2 py-1.5 font-medium">Frage</th>
                  <th className="w-px px-2 py-1.5 font-medium">Herkunft</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((q, i) => (
                  <tr
                    key={q.id}
                    aria-selected={selected.includes(i)}
                    onClick={(e) => clickRow(i, e)}
                    onDoubleClick={() => setEditing(q)}
                    className={`cursor-default border-b border-line/60 ${selected.includes(i) ? 'bg-accent-soft' : 'hover:bg-hover'}`}
                  >
                    <td className="px-2 py-1.5 text-ok">{q.approved ? '✓' : ''}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-muted">{KIND_LABEL[q.kind]}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-muted">{q.subject}</td>
                    <td className="max-w-0 truncate px-2 py-1.5" title={sourceText(q)}>{questionTitle(q)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-muted">{ORIGIN_LABEL[q.origin] ?? q.origin}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!shown.length && <Empty>{all.length ? 'Keine Frage passt zum Filter.' : 'Noch keine Fragen. Generiere sie im Tab „Fächer“ oder lege eigene an.'}</Empty>}
          </div>
          <div className="border-t border-line px-3 py-1.5 text-[12px] text-muted">
            {shown.length} von {all.length} Fragen · {pending} nicht freigegeben
          </div>
        </Panel>

        <Panel title="Vorschau" className="min-w-0 flex-[2]">
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {sel[0] ? <Markdown text={questionMarkdown(sel[0])} /> : <Empty>Wähle eine Frage aus.</Empty>}
          </div>
        </Panel>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Button variant="primary" onClick={newQuestion}>Neue Frage</Button>
        <Button onClick={() => sel[0] && setEditing(sel[0])} disabled={!sel.length}>Bearbeiten</Button>
        <Button onClick={() => approve(sel.map((q) => q.id!), true)} disabled={!sel.length}>Freigeben</Button>
        <Button onClick={() => approve(sel.map((q) => q.id!), false)} disabled={!sel.length}>Freigabe entziehen</Button>
        <Button onClick={approveAll} disabled={!shown.length}>Alle angezeigten freigeben</Button>
        <Button onClick={addToSet} disabled={!sel.length}>Zu Übungssatz …</Button>
        <Button onClick={() => sel[0] && api.openSource(sel[0].source_path)} disabled={!sel[0]?.source_path}>Quelle öffnen</Button>
        <Button variant="danger" className="ml-auto" onClick={remove} disabled={!sel.length}>Löschen</Button>
      </div>

      {editing && <QuestionDialog question={editing} subjects={subjects} onSave={save} onClose={() => setEditing(null)} />}
    </div>
  )
}
