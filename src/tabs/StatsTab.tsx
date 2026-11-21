// Tab „Statistik“: Erfolgsquote pro Fach und die schwächsten Fragen.

import { useEffect, useState } from 'react'
import { questionTitle } from '../../shared/logic'
import type { Question, SubjectStat } from '../../shared/types'
import { Empty, Panel } from '../components/ui'
import { api, useApp } from '../state'

function Rate({ rate }: { rate: number | null }) {
  if (rate == null) return <span className="text-muted">–</span>
  const pct = Math.round(100 * rate)
  const tone = pct >= 81 ? 'bg-ok' : pct >= 50 ? 'bg-warn' : 'bg-bad'
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-2">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="w-10 text-right tabular-nums">{pct} %</span>
    </span>
  )
}

export function StatsTab({ active }: { active: boolean }) {
  const app = useApp()
  const [stats, setStats] = useState<SubjectStat[]>([])
  const [weak, setWeak] = useState<{ rate: number; n: number; q: Question }[]>([])

  useEffect(() => {
    if (!active) return
    void (async () => {
      const [s, rates, qs] = await Promise.all([api.subjectStats(), api.successRates(), api.questions()])
      setStats(s)
      const byId = new Map(qs.map((q) => [q.id, q]))
      setWeak(
        Object.entries(rates)
          .flatMap(([id, [rate, n]]) => {
            const q = byId.get(Number(id))
            return q && rate < 1 ? [{ rate, n, q }] : []
          })
          .sort((a, b) => a.rate - b.rate || b.n - a.n)
          .slice(0, 30),
      )
    })()
  }, [active, app.version])

  const th = 'px-3 py-1.5 font-medium'
  const narrow = 'w-px whitespace-nowrap px-3 py-1.5 font-medium'
  const td = 'px-3 py-1.5'
  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <Panel title="Nach Fach" className="max-h-[40%]">
        <div className="min-h-0 overflow-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead className="sticky top-0 bg-surface-2 text-left text-[12px] text-muted">
              <tr><th className={th}>Fach</th><th className={th}>Fragen</th><th className={th}>Beantwortet</th><th className={th}>Erfolgsquote</th></tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.name} className="border-b border-line/60">
                  <td className={td}>{s.name}</td>
                  <td className={`${td} tabular-nums`}>{s.questions}</td>
                  <td className={`${td} tabular-nums`}>{s.attempts}</td>
                  <td className={td}><Rate rate={s.rate} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!stats.length && <Empty>Noch keine Fächer.</Empty>}
        </div>
      </Panel>
      <Panel title="Schwächste Fragen" className="min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead className="sticky top-0 bg-surface-2 text-left text-[12px] text-muted">
              <tr><th className={narrow}>Quote</th><th className={narrow}>Versuche</th><th className={narrow}>Fach</th><th className={th}>Frage</th></tr>
            </thead>
            <tbody>
              {weak.map(({ rate, n, q }) => (
                <tr key={q.id} className="border-b border-line/60">
                  <td className={td}><Rate rate={rate} /></td>
                  <td className={`${td} tabular-nums`}>{n}</td>
                  <td className={`${td} whitespace-nowrap text-muted`}>{q.subject}</td>
                  <td className={`${td} max-w-0 truncate`}>{questionTitle(q)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!weak.length && <Empty>Noch keine falsch beantworteten Fragen – mach eine Probeprüfung.</Empty>}
        </div>
      </Panel>
    </div>
  )
}
