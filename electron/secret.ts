// Der API-Key: aus ANTHROPIC_API_KEY oder in den Einstellungen gespeichert.
//
// Gespeicherte Keys verschlüsselt Electrons safeStorage mit einem Schlüssel aus dem Schlüsselbund
// (GNOME Keyring, KWallet). Ohne Schlüsselbund wäre das nur Schein – dann liegt der Key im Klartext
// in einer Datei, die nur der Benutzer lesen darf, und die Einstellungen sagen das offen.

import { safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_DIR } from './config'

const KEY_FILE = path.join(CONFIG_DIR, 'api-key.json')

interface Stored {
  encrypted: boolean
  value: string // base64 (verschlüsselt) bzw. Klartext
}

/** Echte Verschlüsselung über einen Schlüsselbund verfügbar? (erst nach app.whenReady() aufrufen) */
export function keyringAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  const backend = safeStorage.getSelectedStorageBackend?.() ?? 'unknown'
  return backend !== 'basic_text' && backend !== 'unknown'
}

function storedKey(): string {
  try {
    const s = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')) as Stored
    return s.encrypted ? safeStorage.decryptString(Buffer.from(s.value, 'base64')) : s.value
  } catch {
    return ''
  }
}

export function keySource(): 'env' | 'app' | null {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return 'env'
  return storedKey() ? 'app' : null
}

/** Die Umgebungsvariable hat Vorrang vor dem gespeicherten Key. */
export function apiKey(): string {
  return process.env.ANTHROPIC_API_KEY?.trim() || storedKey()
}

export function saveKey(key: string): void {
  const encrypted = keyringAvailable()
  const stored: Stored = encrypted
    ? { encrypted, value: safeStorage.encryptString(key).toString('base64') }
    : { encrypted, value: key }
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  const tmp = `${KEY_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 })
  fs.renameSync(tmp, KEY_FILE)
}

export function clearKey(): void {
  fs.rmSync(KEY_FILE, { force: true })
}
