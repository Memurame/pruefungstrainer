// Bündelt Hauptprozess und Preload mit allen Abhängigkeiten, damit das Paket ohne node_modules auskommt.

import { build } from 'esbuild'
import fs from 'node:fs'

const out = 'dist-electron'
fs.rmSync(out, { recursive: true, force: true })

const common = { bundle: true, platform: 'node', target: 'node22', external: ['electron'], logLevel: 'warning', legalComments: 'none' }

await build({
  ...common,
  entryPoints: ['electron/main.ts'],
  outfile: `${out}/main.mjs`,
  format: 'esm',
  // Einige Abhängigkeiten nutzen require(); im ESM-Bündel gibt es das sonst nicht
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
})

// Mit sandbox: true muss der Preload CommonJS sein
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: `${out}/preload.cjs`, format: 'cjs' })

// pdf.js braucht CMaps und Standardschriften zur Laufzeit
for (const dir of ['cmaps', 'standard_fonts']) {
  fs.cpSync(`node_modules/pdfjs-dist/${dir}`, `${out}/pdfjs/${dir}`, { recursive: true })
}
