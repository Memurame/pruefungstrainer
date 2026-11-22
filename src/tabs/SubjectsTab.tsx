// Tab „Fächer“: Fächer anlegen, Dateien/Ordner zuordnen, Fragen per KI generieren bzw. aus
// Altklausuren übernehmen.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { basename, dirname } from '../../shared/logic'
import type { Kind, ScanInfo, SectionInfo, Source, Subject } from '../../shared/types'
import { useDialogs } from '../components/dialogs'
import { Badge, Button, Check, Empty, NumberInput, Panel, ProgressBar } from '../components/ui'
import { api, useApp } from '../state'

const IMAGE = /\.(png|jpe?g|webp|gif)$/i
const isImage = (f: string) => IMAGE.test(f)

type Status = 'neu' | 'erledigt' | 'geändert'

function status(s: SectionInfo, done: Record<string, string>): Status {
  if (!(s.key in done)) return 'neu'
  return done[s.key] === s.hash ? 'erledigt' : 'geändert'
}

function aggregate(states: Status[]): string {
  if (!states.length) return '–'
  return states.every((s) => s === 'erledigt') ? 'erledigt' : 'offen'
}

function StatusBadge({ text }: { text: string }) {
  const tone = text === 'erledigt' ? 'ok' : text === '–' ? 'neutral' : text === 'nicht gefunden' ? 'bad' : 'warn'
  return <Badge tone={tone}>{text}</Badge>
}

interface Node {
  id: string // 'src:<id>', 'file:<pfad>' oder 'sec:<key>'
  label: string
  title?: string
  status: string
  depth: number
  children: Node[]
  sectionKeys: string[] // alle Abschnitte darunter (für „Auswahl verarbeiten“)
  source?: Source
}

export function SubjectsTab() {
  const app = useApp()
  const dialogs = useDialogs()
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [counts, setCounts] = useState<Record<number, number>>({})
  const [current, setCurrent] = useState<number | null>(null)
  const [sources, setSources] = useState<Source[]>([])
  const [done, setDone] = useState<Record<string, string>>({})
  const [scanInfo, setScanInfo] = useState<ScanInfo | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<'scan' | 'generate' | null>(null)
  const [prog, setProg] = useState({ done: 0, total: 0 })
  const [log, setLog] = useState<string[]>([])
  const [count, setCount] = useState(5)
  const [kinds, setKinds] = useState<Record<'mc' | 'frei', boolean>>({ mc: true, frei: true })
  const logRef = useRef<HTMLDivElement>(null)

  const addLog = useCallback((...lines: string[]) => setLog((l) => [...l, ...lines].slice(-500)), [])

  useEffect(() => {
    if (app.config) setCount(app.config.questions_per_section)
  }, [app.config])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log])

  // Fächerliste
  useEffect(() => {
    void (async () => {
      const [list, c] = await Promise.all([api.subjects(), api.questionCounts()])
      setSubjects(list)
      setCounts(c)
      setCurrent((cur) => (cur != null && list.some((s) => s.id === cur) ? cur : (list[0]?.id ?? null)))
    })()
  }, [app.version])

  // Quellen und Stand des gewählten Fachs
  useEffect(() => {
    if (current == null) {
      setSources([])
      setDone({})
      return
    }
    void Promise.all([api.sources(current), api.generatedHashes(current)]).then(([s, d]) => {
      setSources(s)
      setDone(d)
    })
  }, [current, app.version, scanInfo])

  useEffect(() => setSelected(new Set()), [current])

  // Fortschritt aus dem Hauptprozess
  useEffect(
    () =>
      api.onProgress((p) => {
        if (p.job !== 'generate') return
        setProg({ done: p.done, total: p.total })
        if (p.msg) addLog(p.msg)
        if (p.msg.startsWith('  ')) app.bump()
      }),
    [addLog, app],
  )

  const scan = useCallback(async () => {
    setBusy('scan')
    setProg({ done: 0, total: 0 })
    try {
      const result = await api.scan()
      setScanInfo(result)
      addLog(...result.errors.map((e) => `Fehler: ${e}`))
      if (result.newNoteQuestions) {
        addLog(`${result.newNoteQuestions} neue Fragen aus Notizen übernommen.`)
        app.bump()
      }
    } catch (e) {
      addLog(`Fehler: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(null)
    }
    // Bewusst nur von addLog abhängig: ein neuer Scan soll nicht bei jeder Datenänderung laufen
  }, [addLog])

  useEffect(() => {
    void scan()
  }, [scan, app.scanToken])

  const changed = () => app.bump()

  // --- Fächer ---------------------------------------------------------

  const subjectName = (id: number | null) => subjects.find((s) => s.id === id)?.name ?? ''

  const newSubject = async () => {
    const name = await dialogs.prompt('Neues Fach', 'Name des Fachs:')
    if (!name) return
    const id = await app.guard(() => api.addSubject(name), 'Fach')
    if (id != null) {
      setCurrent(id)
      changed()
    }
  }

  const renameSubject = async () => {
    if (current == null) return
    const name = await dialogs.prompt('Fach umbenennen', 'Neuer Name:', subjectName(current))
    if (!name) return
    if ((await app.guard(async () => (await api.renameSubject(current, name), true), 'Fach')) !== undefined) changed()
  }

  const mergeSubject = async () => {
    const others = subjects.filter((s) => s.id !== current)
    if (current == null || !others.length) {
      await dialogs.alert('Zusammenführen', 'Dafür braucht es mindestens zwei Fächer.')
      return
    }
    const name = subjectName(current)
    const i = await dialogs.choose('Zusammenführen', `„${name}“ mit allen Quellen und Fragen verschieben nach:`, others.map((s) => s.name))
    if (i == null) return
    const target = others[i]
    await app.guard(() => api.mergeSubjects(current, target.id))
    addLog(`„${name}“ in „${target.name}“ zusammengeführt.`)
    setCurrent(target.id)
    changed()
    void scan()
  }

  const deleteSubject = async () => {
    if (current == null) return
    const n = counts[current] ?? 0
    const ok = await dialogs.confirm(
      'Fach löschen',
      `Fach „${subjectName(current)}“ mit ${n} Fragen, allen Ergebnissen und seinen Altklausur-Übungssätzen löschen?\n\nDie Dateien selbst bleiben unverändert.`,
      'Löschen', true,
    )
    if (!ok) return
    await app.guard(() => api.deleteSubject(current))
    changed()
  }

  // --- Quellen --------------------------------------------------------

  const pick = async (what: 'files' | 'folder' | 'exams') => {
    if (current == null) {
      await dialogs.alert('Fach', 'Lege zuerst links ein Fach an.')
      return
    }
    if (await app.guard(() => api.pickSources(current, what))) void scan()
  }

  const chosenSources = () => sources.filter((s) => selected.has(`src:${s.id}`))

  const toggleExam = async () => {
    const chosen = chosenSources()
    if (!chosen.length) {
      await dialogs.alert('Altklausur', 'Wähle oben eine Datei oder einen Ordner (oberste Ebene) aus. Bei Ordnern gelten alle Dateien darin (PDF, Text, Markdown) als Altklausuren.')
      return
    }
    for (const s of chosen) await api.setSourceMode(s.id, s.mode === 'klausur' ? 'lernstoff' : 'klausur')
    void scan()
  }

  const removeSources = async () => {
    const chosen = chosenSources()
    if (!chosen.length) {
      await dialogs.alert('Entfernen', 'Wähle oben eine Datei oder einen Ordner (oberste Ebene) aus.')
      return
    }
    const answer = await dialogs.ask(
      'Entfernen',
      `${chosen.length} Quelle(n) aus dem Fach entfernen.\n\nSollen auch die Fragen aus diesen Dateien gelöscht werden?`,
      'Mit Fragen entfernen', 'Fragen behalten',
    )
    if (answer === null) return
    await app.guard(() => api.removeSources(chosen.map((s) => s.id), answer))
    setSelected(new Set())
    changed()
    void scan()
  }

  const moveSources = async () => {
    const chosen = chosenSources()
    const others = subjects.filter((s) => s.id !== current)
    if (!chosen.length) {
      await dialogs.alert('Verschieben', 'Wähle oben eine Datei oder einen Ordner (oberste Ebene) aus.')
      return
    }
    if (!others.length) {
      await dialogs.alert('Verschieben', 'Lege zuerst das Fach an, in das die Quelle soll.')
      return
    }
    const i = await dialogs.choose(
      'Verschieben', `${chosen.length} Quelle(n) mit ihren Fragen verschieben nach:`, others.map((s) => s.name),
    )
    if (i == null) return
    await app.guard(() => api.moveSources(chosen.map((s) => s.id), others[i].id))
    addLog(`${chosen.length} Quelle(n) nach „${others[i].name}“ verschoben.`)
    setSelected(new Set())
    setCurrent(others[i].id)
    changed()
    void scan()
  }

  // --- Baum -----------------------------------------------------------

  const tree = useMemo(() => {
    const bySection = new Map<string, SectionInfo[]>()
    for (const s of scanInfo?.sections ?? []) {
      if (s.subject_id !== current) continue
      const list = bySection.get(s.path) ?? []
      list.push(s)
      bySection.set(s.path, list)
    }
    const sectionNodes = (file: string, depth: number): Node[] =>
      (bySection.get(file) ?? []).map((s) => ({
        id: `sec:${s.key}`, label: s.label, status: status(s, done), depth, children: [], sectionKeys: [s.key],
      }))

    let total = 0
    let pending = 0
    for (const list of bySection.values()) {
      total += list.length
      pending += list.filter((s) => status(s, done) !== 'erledigt').length
    }

    // Screenshot-Altklausuren hängen am Ordner der Bilder; jede Gruppe erscheint einmal
    const groupDirs = new Set([...bySection.values()].flat().filter((s) => s.imageCount).map((s) => s.path))
    const shownGroups = new Set<string>()
    const groupNode = (dir: string, depth: number, base: string): Node[] => {
      if (!groupDirs.has(dir) || shownGroups.has(dir)) return []
      shownGroups.add(dir)
      const secs = sectionNodes(dir, depth + 1)
      const images = (bySection.get(dir) ?? []).reduce((n, s) => n + (s.imageCount ?? 0), 0)
      const rel = dir.startsWith(base + '/') ? dir.slice(base.length + 1) + ' – ' : ''
      return [{
        id: `group:${dir}`, label: `📷 ${rel}Screenshots (${images} Bilder)`, title: dir, depth, children: secs,
        status: aggregate(secs.map((s) => s.status as Status)), sectionKeys: secs.flatMap((s) => s.sectionKeys),
      }]
    }

    const nodes: Node[] = sources.map((src) => {
      const found = !scanInfo?.errors.includes(`Nicht gefunden: ${src.path}`)
      let children: Node[]
      if (src.kind === 'dir') {
        const files = scanInfo?.files[src.id] ?? []
        // Screenshots einer Altklausur erscheinen gesammelt als Gruppe statt einzeln
        const grouped = (f: string) => src.mode === 'klausur' && isImage(f)
        children = [
          ...files.filter((f) => !grouped(f)).map((f) => {
            const secs = sectionNodes(f, 2)
            return {
              id: `file:${f}`, label: f.startsWith(src.path + '/') ? f.slice(src.path.length + 1) : f, title: f,
              status: aggregate(secs.map((s) => s.status as Status)), depth: 1, children: secs, sectionKeys: secs.flatMap((s) => s.sectionKeys),
            }
          }),
          ...[...new Set(files.filter(grouped).map(dirname))].flatMap((d) => groupNode(d, 1, src.path)),
        ]
      } else if (src.mode === 'klausur' && isImage(src.path)) {
        children = groupNode(dirname(src.path), 1, '')
      } else {
        children = sectionNodes(src.path, 1)
      }
      const keys = children.flatMap((c) => c.sectionKeys)
      const states = children.flatMap((c) => (c.id.startsWith('sec:') ? [c.status] : c.children.map((s) => s.status))) as Status[]
      return {
        id: `src:${src.id}`, label: basename(src.path), title: src.path, source: src,
        status: found ? aggregate(states) : 'nicht gefunden', depth: 0, children, sectionKeys: keys,
      }
    })
    return { nodes, total, pending }
  }, [scanInfo, sources, done, current])

  const visible: Node[] = []
  const walk = (list: Node[]) => {
    for (const n of list) {
      visible.push(n)
      if (expanded.has(n.id)) walk(n.children)
    }
  }
  walk(tree.nodes)

  const toggleExpand = (id: string) =>
    setExpanded((e) => {
      const next = new Set(e)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const lastClicked = useRef<number | null>(null)
  const clickRow = (index: number, e: React.MouseEvent) => {
    const id = visible[index].id
    if (e.shiftKey && lastClicked.current !== null) {
      const [a, b] = lastClicked.current < index ? [lastClicked.current, index] : [index, lastClicked.current]
      setSelected(new Set(visible.slice(a, b + 1).map((n) => n.id)))
      return
    }
    lastClicked.current = index
    if (e.ctrlKey || e.metaKey) {
      setSelected((s) => {
        const next = new Set(s)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    } else {
      setSelected(new Set([id]))
    }
  }

  // --- Generieren -----------------------------------------------------

  const generate = async (scope: 'subject' | 'selection' | 'all') => {
    const keys = new Set<string>()
    const collect = (list: Node[]) => {
      for (const n of list) {
        if (selected.has(n.id)) n.sectionKeys.forEach((k) => keys.add(k))
        collect(n.children)
      }
    }
    collect(tree.nodes)
    const chosenKinds = (['mc', 'frei'] as Kind[]).filter((k) => kinds[k as 'mc' | 'frei'])
    setBusy('generate')
    setProg({ done: 0, total: 0 })
    try {
      const total = await api.generate({ scope, subjectId: current, keys: [...keys], count, kinds: chosenKinds })
      addLog(`Fertig: ${total} neue Fragen. Prüfe sie im Tab „Fragen“ und gib sie frei.`)
    } catch (e) {
      await dialogs.alert('Generieren', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      changed()
    }
  }

  const cancel = async () => {
    const ok = await dialogs.confirm(
      'Verarbeitung abbrechen',
      'Nach dem aktuellen Abschnitt aufhören? Bereits verarbeitete Abschnitte bleiben erhalten, die übrigen kannst du später verarbeiten.',
      'Abbrechen', true,
    )
    if (!ok) return
    await api.cancelGenerate()
    addLog('Wird nach dem aktuellen Abschnitt abgebrochen …')
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="flex min-h-0 flex-1 gap-3">
        <Panel title="Fächer" className="w-72 shrink-0">
          <ul className="min-h-0 flex-1 overflow-y-auto p-1.5" role="listbox">
            {subjects.map((s) => (
              <li
                key={s.id}
                role="option"
                aria-selected={s.id === current}
                onClick={() => setCurrent(s.id)}
                className={`flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] ${
                  s.id === current ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-hover'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <span className="text-[12px] text-muted tabular-nums" title={`${counts[s.id] ?? 0} Fragen`}>{counts[s.id] ?? 0}</span>
              </li>
            ))}
            {!subjects.length && <li className="px-2.5 py-2 text-[13px] text-muted">Noch keine Fächer.</li>}
          </ul>
          <div className="grid grid-cols-2 gap-1.5 border-t border-line p-2">
            <Button variant="primary" onClick={newSubject}>Neues Fach …</Button>
            <Button onClick={renameSubject} disabled={current == null}>Umbenennen …</Button>
            <Button onClick={mergeSubject} disabled={current == null}>Zusammenführen …</Button>
            <Button variant="danger" onClick={deleteSubject} disabled={current == null}>Löschen</Button>
          </div>
        </Panel>

        <Panel
          className="min-w-0 flex-1"
          title={current == null ? 'Kein Fach ausgewählt' : subjectName(current)}
          actions={<Button variant="ghost" onClick={scan} disabled={busy !== null}>{busy === 'scan' ? 'Liest ein …' : 'Neu einlesen'}</Button>}
        >
          {current == null ? (
            <Empty>Lege links ein Fach an und füge ihm Notizen, PDFs oder Ordner hinzu.</Empty>
          ) : !sources.length ? (
            <Empty>Noch keine Quellen. Füge Dateien oder Ordner hinzu.</Empty>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto select-none" role="tree">
              {visible.map((n, i) => (
                <div
                  key={n.id}
                  role="treeitem"
                  aria-selected={selected.has(n.id)}
                  title={n.title}
                  onClick={(e) => clickRow(i, e)}
                  onDoubleClick={() => n.children.length && toggleExpand(n.id)}
                  className={`flex cursor-default items-center gap-1.5 border-b border-line/60 py-1.5 pr-3 text-[13px] ${
                    selected.has(n.id) ? 'bg-accent-soft' : 'hover:bg-hover'
                  }`}
                  style={{ paddingLeft: 8 + n.depth * 20 }}
                >
                  <button
                    className={`flex size-5 items-center justify-center rounded text-muted hover:bg-hover ${n.children.length ? '' : 'invisible'}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleExpand(n.id)
                    }}
                    aria-label={expanded.has(n.id) ? 'Zuklappen' : 'Aufklappen'}
                  >
                    <span className={`text-[10px] transition-transform ${expanded.has(n.id) ? 'rotate-90' : ''}`}>▶</span>
                  </button>
                  <span className="shrink-0">{n.source ? (n.source.kind === 'dir' ? '📁' : isImage(n.source.path) ? '🖼️' : '📄') : n.id.startsWith('file:') ? (isImage(n.id) ? '🖼️' : '📄') : ''}</span>
                  <span className="min-w-0 flex-1 truncate">{n.label}</span>
                  {n.source?.mode === 'klausur' && <Badge tone="accent">Altklausur</Badge>}
                  <StatusBadge text={n.status} />
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5 border-t border-line p-2">
            <Button onClick={() => pick('files')} disabled={busy !== null}>Dateien hinzufügen …</Button>
            <Button onClick={() => pick('folder')} disabled={busy !== null}>Ordner hinzufügen …</Button>
            <Button onClick={() => pick('exams')} disabled={busy !== null}>Altklausur hinzufügen …</Button>
            <Button onClick={toggleExam} disabled={busy !== null}>Altklausur ein/aus</Button>
            <Button onClick={moveSources} disabled={busy !== null}>Verschieben …</Button>
            <Button variant="danger" onClick={removeSources} disabled={busy !== null}>Entfernen</Button>
            <span className="ml-auto text-[12px] text-muted">
              {sources.length ? `${sources.length} Quellen, ${tree.total} Abschnitte, davon ${tree.pending} ohne aktuelle Fragen` : ''}
            </span>
          </div>
        </Panel>
      </div>

      <Panel>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 p-3">
          <label className="flex items-center gap-2 text-[13px]">
            Fragen pro Abschnitt
            <NumberInput value={count} min={1} max={20} onChange={setCount} className="w-16" />
          </label>
          <Check label="Multiple Choice" checked={kinds.mc} onChange={(v) => setKinds((k) => ({ ...k, mc: v }))} />
          <Check label="Freitext" checked={kinds.frei} onChange={(v) => setKinds((k) => ({ ...k, frei: v }))} />
          <span className="text-[12px] italic text-muted">Altklausuren werden immer vollständig übernommen.</span>
          <div className="ml-auto flex gap-1.5">
            {/* Die Knöpfe bleiben während der Verarbeitung stehen (nur gesperrt), damit ein zweiter
                Klick nicht versehentlich „Abbrechen“ trifft */}
            <Button variant="primary" onClick={() => generate('subject')} disabled={busy !== null || current == null}>
              Neue/geänderte Abschnitte verarbeiten
            </Button>
            <Button onClick={() => generate('selection')} disabled={busy !== null || !selected.size}>Auswahl (neu) verarbeiten</Button>
            <Button onClick={() => generate('all')} disabled={busy !== null} title="Neue/geänderte Abschnitte aller Fächer verarbeiten">
              Alle Fächer
            </Button>
          </div>
        </div>
        {busy && (
          <div className="flex items-center gap-3 px-3 pb-2">
            <div className="flex-1"><ProgressBar done={prog.done} total={busy === 'scan' ? 0 : prog.total} /></div>
            {busy === 'generate' && (
              <>
                <span className="text-[12px] text-muted tabular-nums">
                  {prog.total ? `Abschnitt ${Math.min(prog.done + 1, prog.total)} von ${prog.total}` : 'Startet …'}
                </span>
                <Button variant="danger" onClick={cancel}>Verarbeitung abbrechen</Button>
              </>
            )}
          </div>
        )}
        <div ref={logRef} className="h-28 overflow-y-auto border-t border-line bg-surface-2/50 px-3 py-2 font-mono text-[12px] leading-relaxed text-muted">
          {log.length ? log.map((l, i) => <div key={i} className="whitespace-pre-wrap">{l}</div>) : <div>Protokoll</div>}
        </div>
      </Panel>
    </div>
  )
}
