// Einstellungen: liegen in ~/.config/pruefungstrainer/config.json, Daten in ~/.local/share/pruefungstrainer.
// Der API-Key liegt nicht hier, sondern verschlüsselt in api-key.json (siehe secret.ts).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config } from '../shared/types'

const home = os.homedir()
export const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'pruefungstrainer')
export const DATA_DIR = path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'pruefungstrainer')
export const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'pruefungstrainer')
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
export const DB_FILE = path.join(DATA_DIR, 'pruefungstrainer.sqlite3')

const DEFAULTS: Config = {
  last_dir: '',
  model: 'claude-opus-5-5',
  questions_per_section: 5,
  // Ordner, die beim Einlesen übersprungen werden (z. B. Templates)
  ignore_dirs: '.obsidian, .trash, Templates',
}

export function loadConfig(): Config {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>
    const cfg = { ...DEFAULTS }
    for (const key of Object.keys(DEFAULTS) as (keyof Config)[]) {
      if (typeof data[key] === typeof DEFAULTS[key]) (cfg as Record<string, unknown>)[key] = data[key]
    }
    return cfg
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveConfig(cfg: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  const tmp = `${CONFIG_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2))
  fs.renameSync(tmp, CONFIG_FILE)
}

export function ignored(cfg: Config): Set<string> {
  return new Set(cfg.ignore_dirs.split(',').map((d) => d.trim()).filter(Boolean))
}
