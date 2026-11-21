import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppInfo, Config } from '../shared/types'
import { api, AppCtx, type AppState } from './state'
import { useDialogs } from './components/dialogs'
import { Button } from './components/ui'
import { ExamTab } from './tabs/ExamTab'
import { ExportDialog, SettingsDialog } from './tabs/MenuDialogs'
import { QuestionsTab } from './tabs/QuestionsTab'
import { SetsTab } from './tabs/SetsTab'
import { StatsTab } from './tabs/StatsTab'
import { SubjectsTab } from './tabs/SubjectsTab'

const TABS = [
  { id: 'subjects', label: 'Fächer' },
  { id: 'questions', label: 'Fragen' },
  { id: 'sets', label: 'Übungssätze' },
  { id: 'exam', label: 'Prüfung' },
  { id: 'stats', label: 'Statistik' },
] as const

type TabId = (typeof TABS)[number]['id']

export default function App() {
  const dialogs = useDialogs()
  const [tab, setTab] = useState<TabId>('subjects')
  const [version, setVersion] = useState(0)
  const [scanToken, setScanToken] = useState(0)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [config, setConfig] = useState<Config | null>(null)
  const [message, setMessage] = useState('')
  const [dialog, setDialog] = useState<'settings' | 'export' | null>(null)
  const timer = useRef<number | undefined>(undefined)

  const notify = useCallback((msg: string) => {
    setMessage(msg)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setMessage(''), 8000)
  }, [])

  const guard = useCallback(
    async <T,>(fn: () => Promise<T>, title = 'Fehler'): Promise<T | undefined> => {
      try {
        return await fn()
      } catch (e) {
        await dialogs.alert(title, e instanceof Error ? e.message : String(e))
        return undefined
      }
    },
    [dialogs],
  )

  useEffect(() => {
    void api.info().then(setInfo)
    void api.getConfig().then(setConfig)
  }, [])

  const state: AppState = useMemo(
    () => ({
      version, bump: () => setVersion((v) => v + 1), scanToken, requestScan: () => setScanToken((t) => t + 1),
      info, config, setConfig, notify, guard, refreshInfo: () => api.info().then(setInfo),
    }),
    [version, scanToken, info, config, notify, guard],
  )

  const importData = async () => {
    const result = await guard(() => api.importData(), 'Importieren')
    if (result) {
      state.bump()
      state.requestScan()
      await dialogs.alert('Importieren', result)
    }
  }

  const noKey = info !== null && !info.hasApiKey

  return (
    <AppCtx.Provider value={state}>
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-1 border-b border-line bg-surface px-3">
          <div className="mr-4 flex items-center gap-2 py-2.5 font-semibold">
            <span className="flex size-6 items-center justify-center rounded-md bg-accent text-[12px] text-accent-fg">P</span>
            Prüfungstrainer
          </div>
          <nav className="flex flex-1 gap-0.5" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`relative px-3 py-3 text-[13px] font-medium transition-colors ${
                  tab === t.id ? 'text-fg' : 'text-muted hover:text-fg'
                }`}
              >
                {t.label}
                {tab === t.id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
              </button>
            ))}
          </nav>
          <Button variant="ghost" onClick={() => setDialog('export')}>Exportieren …</Button>
          <Button variant="ghost" onClick={importData}>Importieren …</Button>
          <Button variant="ghost" onClick={() => setDialog('settings')}>Einstellungen</Button>
        </header>

        <main className="relative min-h-0 flex-1">
          {/* Alle Tabs bleiben geladen, damit z. B. eine laufende Prüfung beim Wechseln erhalten bleibt */}
          <div className={tab === 'subjects' ? 'contents' : 'hidden'}><SubjectsTab /></div>
          <div className={tab === 'questions' ? 'contents' : 'hidden'}><QuestionsTab /></div>
          <div className={tab === 'sets' ? 'contents' : 'hidden'}><SetsTab /></div>
          <div className={tab === 'exam' ? 'contents' : 'hidden'}><ExamTab active={tab === 'exam'} /></div>
          <div className={tab === 'stats' ? 'contents' : 'hidden'}><StatsTab active={tab === 'stats'} /></div>
        </main>

        {(message || noKey) && (
          <footer className="border-t border-line bg-surface px-4 py-1.5 text-[12px] text-muted">
            {message || 'Kein API-Key – trage ihn unter Einstellungen ein, bis dahin sind die KI-Funktionen aus.'}
          </footer>
        )}
      </div>

      {dialog === 'settings' && <SettingsDialog onClose={() => setDialog(null)} />}
      {dialog === 'export' && <ExportDialog onClose={() => setDialog(null)} />}
    </AppCtx.Provider>
  )
}
