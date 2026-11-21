// Einstellungen und Export.

import { useEffect, useState } from 'react'
import type { Subject } from '../../shared/types'
import { Modal } from '../components/dialogs'
import { Badge, Button, Check, Input } from '../components/ui'
import { api, useApp } from '../state'

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']

/** API-Key eingeben, prüfen und (verschlüsselt) speichern. */
function KeySection() {
  const app = useApp()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const info = app.info

  const save = async () => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      const warning = await api.setApiKey(key)
      setKey('')
      setNote(warning ?? 'Key geprüft und gespeichert.')
      await app.refreshInfo()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    await app.guard(() => api.clearApiKey())
    setNote('Gespeicherten Key entfernt.')
    await app.refreshInfo()
  }

  if (info?.keySource === 'env') {
    return (
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2 font-medium">API-Key <Badge tone="ok">aus ANTHROPIC_API_KEY</Badge></div>
        <p className="leading-relaxed text-muted">
          Die Umgebungsvariable <code className="rounded bg-surface-2 px-1">ANTHROPIC_API_KEY</code> ist gesetzt und hat Vorrang vor
          einem hier gespeicherten Key.
        </p>
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2 font-medium">
        API-Key
        {info?.keySource === 'app' ? <Badge tone="ok">gespeichert</Badge> : <Badge tone="bad">nicht gesetzt</Badge>}
      </div>
      <div className="flex gap-2">
        <Input
          type="password"
          className="flex-1 font-mono"
          placeholder={info?.keySource === 'app' ? 'Neuen Key eingeben, um ihn zu ersetzen' : 'sk-ant-…'}
          value={key}
          autoComplete="off"
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && key.trim() && !busy && save()}
        />
        <Button variant="primary" onClick={save} disabled={!key.trim() || busy}>{busy ? 'Prüft …' : 'Key speichern'}</Button>
        {info?.keySource === 'app' && <Button variant="danger" onClick={remove}>Entfernen</Button>}
      </div>
      {error && <p className="text-bad">{error}</p>}
      {note && !error && <p className="text-ok">{note}</p>}
      <p className="leading-relaxed text-muted">
        {info?.keyring
          ? 'Der Key wird verschlüsselt gespeichert; den Schlüssel dazu verwaltet dein Schlüsselbund (z. B. GNOME Keyring).'
          : 'Kein Schlüsselbund gefunden: Der Key wird im Klartext in einer Datei gespeichert, die nur du lesen kannst.'}{' '}
        Einen Key bekommst du unter console.anthropic.com. Alternativ liest die App die Umgebungsvariable{' '}
        <code className="rounded bg-surface-2 px-1">ANTHROPIC_API_KEY</code>.
      </p>
    </section>
  )
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const app = useApp()
  const [model, setModel] = useState(app.config?.model ?? MODELS[0])
  const [ignore, setIgnore] = useState(app.config?.ignore_dirs ?? '')

  const save = async () => {
    const cfg = await app.guard(() => api.saveConfig({ model: model.trim() || MODELS[0], ignore_dirs: ignore }))
    if (cfg) {
      app.setConfig(cfg)
      app.notify('Einstellungen gespeichert.')
      onClose()
    }
  }

  return (
    <Modal
      title="Einstellungen"
      onClose={onClose}
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" onClick={save}>Speichern</Button>
        </>
      }
    >
      <div className="flex flex-col gap-5 text-[13px]">
        <KeySection />
        <label className="flex flex-col gap-1.5 font-medium">
          Modell
          <Input list="models" value={model} onChange={(e) => setModel(e.target.value)} />
          <datalist id="models">{MODELS.map((m) => <option key={m} value={m} />)}</datalist>
        </label>
        <label className="flex flex-col gap-1.5 font-medium">
          Ignorierte Ordner (kommagetrennt)
          <Input value={ignore} onChange={(e) => setIgnore(e.target.value)} />
        </label>
        <p className="text-[12px] text-muted">
          Daten: {app.info?.dbFile}
          <br />
          Einstellungen: {app.info?.configFile}
        </p>
      </div>
    </Modal>
  )
}

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const app = useApp()
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [counts, setCounts] = useState<Record<number, number>>({})
  const [chosen, setChosen] = useState<Set<number>>(new Set())

  useEffect(() => {
    void Promise.all([api.subjects(), api.questionCounts()]).then(([s, c]) => {
      setSubjects(s)
      setCounts(c)
      setChosen(new Set(s.map((x) => x.id)))
    })
  }, [])

  const run = async () => {
    const result = await app.guard(() => api.exportData([...chosen]), 'Exportieren')
    if (result) {
      app.notify(`${result.subjects} Fächer, ${result.questions} Fragen und ${result.sets} Übungssätze nach ${result.file} exportiert.`)
      onClose()
    }
  }

  return (
    <Modal
      title="Exportieren"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" onClick={run} disabled={!chosen.size}>Exportieren …</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        {subjects.length ? (
          <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
            {subjects.map((s) => (
              <Check
                key={s.id}
                label={<>{s.name} <span className="text-muted">({counts[s.id] ?? 0} Fragen)</span></>}
                checked={chosen.has(s.id)}
                onChange={(v) =>
                  setChosen((c) => {
                    const next = new Set(c)
                    if (v) next.add(s.id)
                    else next.delete(s.id)
                    return next
                  })
                }
              />
            ))}
          </div>
        ) : (
          <p className="text-muted">Es gibt noch keine Fächer.</p>
        )}
        <p className="text-[12px] leading-relaxed text-muted">
          Exportiert werden die gewählten Fächer mit ihren Fragen und die Übungssätze, die Fragen daraus enthalten. Quellen und
          Prüfungsergebnisse gehören nicht dazu.
        </p>
      </div>
    </Modal>
  )
}
