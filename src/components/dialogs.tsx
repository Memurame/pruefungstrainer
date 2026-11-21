// Modale Dialoge: Meldung, Rückfrage, Texteingabe und Auswahl – jeweils als Promise.

import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Button, Input, Select } from './ui'

export function Modal({ title, children, footer, onClose, width = 'max-w-md' }: {
  title: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; width?: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`flex max-h-full w-full ${width} flex-col rounded-xl border border-line bg-surface shadow-2xl`} role="dialog" aria-modal="true">
        <header className="border-b border-line px-5 py-3 text-[15px] font-semibold">{title}</header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  )
}

interface Dialogs {
  alert(title: string, message: string): Promise<void>
  confirm(title: string, message: string, ok?: string, danger?: boolean): Promise<boolean>
  /** Ja / Nein / Abbrechen: true, false oder null. */
  ask(title: string, message: string, yes: string, no: string): Promise<boolean | null>
  prompt(title: string, label: string, initial?: string): Promise<string | null>
  choose(title: string, label: string, options: string[]): Promise<number | null>
}

const Ctx = createContext<Dialogs | null>(null)

export function useDialogs(): Dialogs {
  const d = useContext(Ctx)
  if (!d) throw new Error('DialogProvider fehlt')
  return d
}

type Pending =
  | { type: 'alert'; title: string; message: string; resolve: () => void }
  | { type: 'confirm'; title: string; message: string; ok: string; danger: boolean; resolve: (v: boolean) => void }
  | { type: 'ask'; title: string; message: string; yes: string; no: string; resolve: (v: boolean | null) => void }
  | { type: 'prompt'; title: string; label: string; initial: string; resolve: (v: string | null) => void }
  | { type: 'choose'; title: string; label: string; options: string[]; resolve: (v: number | null) => void }

function Message({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{text}</p>
}

function PromptBody({ p, close }: { p: Extract<Pending, { type: 'prompt' }>; close: () => void }) {
  const [value, setValue] = useState(p.initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.select(), [])
  const done = (v: string | null) => {
    p.resolve(v)
    close()
  }
  return (
    <Modal
      title={p.title}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Abbrechen</Button>
          <Button variant="primary" disabled={!value.trim()} onClick={() => done(value.trim())}>OK</Button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5 text-[13px]">
        {p.label}
        <Input ref={ref} autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && value.trim() && done(value.trim())} />
      </label>
    </Modal>
  )
}

function ChooseBody({ p, close }: { p: Extract<Pending, { type: 'choose' }>; close: () => void }) {
  const [value, setValue] = useState(0)
  const done = (v: number | null) => {
    p.resolve(v)
    close()
  }
  return (
    <Modal
      title={p.title}
      onClose={() => done(null)}
      footer={
        <>
          <Button onClick={() => done(null)}>Abbrechen</Button>
          <Button variant="primary" onClick={() => done(value)}>OK</Button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5 text-[13px]">
        {p.label}
        <Select autoFocus value={value} onChange={(e) => setValue(Number(e.target.value))}>
          {p.options.map((o, i) => (
            <option key={i} value={i}>{o}</option>
          ))}
        </Select>
      </label>
    </Modal>
  )
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([])
  const push = useCallback((p: Pending) => setQueue((q) => [...q, p]), [])
  const close = useCallback(() => setQueue((q) => q.slice(1)), [])

  const [api] = useState<Dialogs>(() => ({
    alert: (title, message) => new Promise((resolve) => push({ type: 'alert', title, message, resolve })),
    confirm: (title, message, ok = 'OK', danger = false) => new Promise((resolve) => push({ type: 'confirm', title, message, ok, danger, resolve })),
    ask: (title, message, yes, no) => new Promise((resolve) => push({ type: 'ask', title, message, yes, no, resolve })),
    prompt: (title, label, initial = '') => new Promise((resolve) => push({ type: 'prompt', title, label, initial, resolve })),
    choose: (title, label, options) => new Promise((resolve) => push({ type: 'choose', title, label, options, resolve })),
  }))

  const p = queue[0]
  let modal: ReactNode = null
  if (p?.type === 'alert') {
    const done = () => {
      p.resolve()
      close()
    }
    modal = (
      <Modal title={p.title} onClose={done} footer={<Button variant="primary" autoFocus onClick={done}>OK</Button>}>
        <Message text={p.message} />
      </Modal>
    )
  } else if (p?.type === 'confirm') {
    const done = (v: boolean) => {
      p.resolve(v)
      close()
    }
    modal = (
      <Modal
        title={p.title}
        onClose={() => done(false)}
        footer={
          <>
            <Button onClick={() => done(false)}>Abbrechen</Button>
            <Button variant={p.danger ? 'danger' : 'primary'} autoFocus onClick={() => done(true)}>{p.ok}</Button>
          </>
        }
      >
        <Message text={p.message} />
      </Modal>
    )
  } else if (p?.type === 'ask') {
    const done = (v: boolean | null) => {
      p.resolve(v)
      close()
    }
    modal = (
      <Modal
        title={p.title}
        onClose={() => done(null)}
        footer={
          <>
            <Button onClick={() => done(null)}>Abbrechen</Button>
            <Button onClick={() => done(false)}>{p.no}</Button>
            <Button variant="primary" autoFocus onClick={() => done(true)}>{p.yes}</Button>
          </>
        }
      >
        <Message text={p.message} />
      </Modal>
    )
  } else if (p?.type === 'prompt') {
    modal = <PromptBody key={queue.length} p={p} close={close} />
  } else if (p?.type === 'choose') {
    modal = <ChooseBody key={queue.length} p={p} close={close} />
  }

  return (
    <Ctx.Provider value={api}>
      {children}
      {modal}
    </Ctx.Provider>
  )
}
