// Gemeinsamer Zustand der Oberfläche: Datenstand, Meldungen und Fehlerbehandlung.

import { createContext, useContext } from 'react'
import type { Api, AppInfo, Config } from '../shared/types'

declare global {
  interface Window {
    api: Api
  }
}

export const api: Api = window.api

export interface AppState {
  /** Zählt bei jeder Datenänderung hoch; Tabs laden dann neu. */
  version: number
  bump(): void
  /** Neues Einlesen der Quellen anstoßen (z. B. nach einem Import). */
  scanToken: number
  requestScan(): void
  info: AppInfo | null
  config: Config | null
  setConfig(c: Config): void
  refreshInfo(): Promise<void>
  notify(msg: string): void
  /** Führt eine Aktion aus und zeigt Fehler als Meldung an. */
  guard<T>(fn: () => Promise<T>, title?: string): Promise<T | undefined>
}

export const AppCtx = createContext<AppState | null>(null)

export function useApp(): AppState {
  const s = useContext(AppCtx)
  if (!s) throw new Error('AppCtx fehlt')
  return s
}
