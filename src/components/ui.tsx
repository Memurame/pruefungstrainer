// Kleine Bausteine der Oberfläche.

import type { ComponentProps, ReactNode } from 'react'

type Variant = 'default' | 'primary' | 'danger' | 'ghost'

const VARIANTS: Record<Variant, string> = {
  default: 'bg-surface border border-line hover:bg-hover',
  primary: 'bg-accent text-accent-fg border border-accent hover:brightness-110',
  danger: 'bg-surface border border-line text-bad hover:bg-bad-soft',
  ghost: 'border border-transparent hover:bg-hover',
}

export function Button({ variant = 'default', className = '', ...props }: ComponentProps<'button'> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-45 ${VARIANTS[variant]} ${className}`}
    />
  )
}

export function Input({ className = '', ...props }: ComponentProps<'input'>) {
  return <input {...props} className={`rounded-md border border-line px-2.5 py-1.5 text-[13px] ${className}`} />
}

export function Select({ className = '', children, ...props }: ComponentProps<'select'>) {
  return (
    <select {...props} className={`rounded-md border border-line px-2 py-1.5 text-[13px] ${className}`}>
      {children}
    </select>
  )
}

export function Check({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`inline-flex cursor-pointer items-center gap-2 text-[13px] ${disabled ? 'opacity-45' : ''}`}>
      <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

export function NumberInput({ value, onChange, min = 0, max = 999, step = 1, className = '', disabled }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; className?: string; disabled?: boolean
}) {
  return (
    <Input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={`w-24 ${className}`}
      onChange={(e) => {
        const v = Number(e.target.value)
        if (!Number.isNaN(v)) onChange(Math.min(max, Math.max(min, v)))
      }}
    />
  )
}

export function Panel({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`flex min-h-0 flex-col rounded-lg border border-line bg-surface ${className}`}>
      {(title || actions) && (
        <header className="flex items-center gap-2 border-b border-line px-3 py-2">
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</h2>
          {actions}
        </header>
      )}
      {children}
    </section>
  )
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'accent'; children: ReactNode }) {
  const tones = {
    neutral: 'bg-surface-2 text-muted',
    ok: 'bg-ok-soft text-ok',
    warn: 'bg-warn-soft text-warn',
    bad: 'bg-bad-soft text-bad',
    accent: 'bg-accent-soft text-accent',
  }
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>
}

export function ProgressBar({ done, total }: { done: number; total: number }) {
  const indeterminate = total <= 0
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <div
        className={`h-full rounded-full bg-accent transition-[width] ${indeterminate ? 'w-1/3 animate-pulse' : ''}`}
        style={indeterminate ? undefined : { width: `${(100 * done) / total}%` }}
      />
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center p-8 text-center text-[13px] text-muted">{children}</div>
}

/** Auswahl in Listen: Klick wählt eine Zeile, Strg/Cmd ergänzt, Umschalt wählt einen Bereich. */
export function selectRows(current: number[], index: number, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, anchor: number | null): number[] {
  if (e.shiftKey && anchor !== null) {
    const [a, b] = anchor < index ? [anchor, index] : [index, anchor]
    return Array.from({ length: b - a + 1 }, (_, i) => a + i)
  }
  if (e.ctrlKey || e.metaKey) return current.includes(index) ? current.filter((i) => i !== index) : [...current, index]
  return [index]
}
