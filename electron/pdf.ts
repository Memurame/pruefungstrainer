// PDFs lesen: Seitenzahl, Seitenauszüge für die KI und Text mit rot markierten Lösungen.
// Die Dateien werden nur gelesen, nie verändert.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
// Der Worker läuft im selben Prozess („fake worker“); so braucht es keine separate Datei.
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs'

;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker

// CMaps und Standardschriften liegen neben dem gebündelten Hauptprozess (siehe build-electron.mjs)
const here = path.dirname(fileURLToPath(import.meta.url))
const assets = path.join(here, 'pdfjs')

async function openPdf(data: Uint8Array) {
  const task = pdfjs.getDocument({
    data,
    cMapUrl: path.join(assets, 'cmaps') + '/',
    cMapPacked: true,
    standardFontDataUrl: path.join(assets, 'standard_fonts') + '/',
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  })
  return { doc: await task.promise, close: () => task.destroy() }
}

export async function pageCount(data: Uint8Array): Promise<number> {
  // pdf.js bekommt eine Kopie, weil es den Puffer an den Worker übergibt
  const { doc, close } = await openPdf(new Uint8Array(data))
  try {
    return doc.numPages
  } finally {
    await close()
  }
}

/** Die Seiten eines Abschnitts als eigenes PDF (0-basiert, Ende exklusiv). */
export async function pdfExcerpt(file: string, pages: [number, number]): Promise<Uint8Array> {
  const src = await PDFDocument.load(fs.readFileSync(file), { ignoreEncryption: true })
  const out = await PDFDocument.create()
  const indices = Array.from({ length: pages[1] - pages[0] }, (_, i) => pages[0] + i)
  for (const page of await out.copyPages(src, indices)) out.addPage(page)
  return out.save()
}

function isRed(hex: string): boolean {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex)
  if (!m) return false
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16))
  return r >= 150 && g <= 90 && b <= 90
}

type Matrix = [number, number, number, number, number, number]
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function multiply(m: Matrix, n: Matrix): Matrix {
  // m × n im Sinne von PDF: zuerst m, dann n
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ]
}

function asMatrix(v: unknown): Matrix | null {
  if (v && typeof v === 'object' && 'length' in v && (v as ArrayLike<number>).length === 6) {
    return Array.from(v as ArrayLike<number>) as Matrix
  }
  return null
}

interface Glyph {
  unicode?: string
  width?: number
  isSpace?: boolean
}

interface Span {
  text: string
  red: boolean
}

/**
 * Text der Seiten, roter Text (Lösungen) in ⟦…⟧. Gibt auch die Zahl roter Zeichen zurück.
 *
 * Liest den Operator-Strom von pdf.js: Füllfarbe, Text- und Transformationsmatrizen,
 * damit Zeilen und Wortabstände ungefähr so herauskommen wie auf der Seite.
 */
export async function markedText(file: string, pages: [number, number]): Promise<[string, number]> {
  const OPS = pdfjs.OPS
  const { doc, close } = await openPdf(new Uint8Array(fs.readFileSync(file)))
  const out: string[] = []
  let redChars = 0
  try {
    for (let pno = pages[0]; pno < pages[1]; pno++) {
      out.push(`--- Seite ${pno + 1} ---`)
      const page = await doc.getPage(pno + 1)
      const list = await page.getOperatorList()

      interface GState { ctm: Matrix; fill: string }
      let gs: GState = { ctm: [...IDENTITY], fill: '#000000' }
      const stack: GState[] = []
      let tm: Matrix = [...IDENTITY]   // Textmatrix
      let tlm: Matrix = [...IDENTITY]  // Zeilenmatrix
      let fontSize = 10
      let leading = 0
      let charSpacing = 0
      let wordSpacing = 0
      let hScale = 1

      let line: Span[] = []
      let lastY: number | null = null
      let lastEndX: number | null = null

      const flush = () => {
        // Leerzeichen gehören zum laufenden Abschnitt, egal welche Farbe
        let text = ''
        let inRed = false
        for (const span of line) {
          const blank = !span.text.trim()
          const red: boolean = blank ? inRed : span.red
          if (red !== inRed) {
            text += red ? '⟦' : '⟧'
            inRed = red
          }
          text += span.text
          if (red) redChars += [...span.text.trim()].length
        }
        if (inRed) text += '⟧'
        if (text.replace(/[⟦⟧ ]/g, '').length) out.push(text.trimEnd())
        line = []
      }

      const moveLine = (tx: number, ty: number) => {
        tlm = multiply([1, 0, 0, 1, tx, ty], tlm)
        tm = [...tlm]
      }

      const show = (glyphs: (Glyph | number | null)[]) => {
        const m = multiply(tm, gs.ctm)
        const x = m[4]
        const y = m[5]
        const scale = Math.hypot(m[2], m[3]) || 1
        const size = Math.abs(fontSize) * scale
        if (lastY !== null && Math.abs(y - lastY) > size * 0.5) {
          flush()
          lastEndX = null
        } else if (lastEndX !== null) {
          if (x < lastEndX - size * 2) {
            flush()
          } else if (x - lastEndX > size * 0.2 && line.length && !/\s$/.test(line[line.length - 1].text)) {
            line.push({ text: ' ', red: false })
          }
        }
        lastY = y

        const red = isRed(gs.fill)
        let text = ''
        let advance = 0 // in Textraum-Einheiten
        for (const g of glyphs) {
          if (typeof g === 'number') {
            // Kerning in TJ: deutlich negativer Wert = sichtbarer Abstand
            if (g < -200 && !/\s$/.test(text)) text += ' '
            advance -= (g / 1000) * fontSize * hScale
            continue
          }
          if (!g) continue
          text += g.unicode ?? ''
          advance += (((g.width ?? 0) / 1000) * fontSize + charSpacing + (g.isSpace ? wordSpacing : 0)) * hScale
        }
        if (text) line.push({ text, red })
        tm = multiply([1, 0, 0, 1, advance, 0], tm)
        lastEndX = multiply(tm, gs.ctm)[4]
      }

      const { fnArray, argsArray } = list
      for (let i = 0; i < fnArray.length; i++) {
        const fn = fnArray[i]
        const args = argsArray[i] as unknown[] | null
        switch (fn) {
          case OPS.save:
            stack.push({ ctm: [...gs.ctm], fill: gs.fill })
            break
          case OPS.restore:
            gs = stack.pop() ?? gs
            break
          case OPS.transform: {
            const m = asMatrix(args)
            if (m) gs.ctm = multiply(m, gs.ctm)
            break
          }
          case OPS.paintFormXObjectBegin: {
            stack.push({ ctm: [...gs.ctm], fill: gs.fill })
            const m = asMatrix(args?.[0])
            if (m) gs.ctm = multiply(m, gs.ctm)
            break
          }
          case OPS.paintFormXObjectEnd:
            gs = stack.pop() ?? gs
            break
          case OPS.setFillRGBColor:
            gs.fill = typeof args?.[0] === 'string' ? (args[0] as string) : '#000000'
            break
          case OPS.setFillTransparent:
            gs.fill = 'transparent'
            break
          case OPS.beginText:
            tm = [...IDENTITY]
            tlm = [...IDENTITY]
            break
          case OPS.setFont:
            fontSize = Number(args?.[1]) || fontSize
            break
          case OPS.setLeading:
            leading = Number(args?.[0]) || 0
            break
          case OPS.setCharSpacing:
            charSpacing = Number(args?.[0]) || 0
            break
          case OPS.setWordSpacing:
            wordSpacing = Number(args?.[0]) || 0
            break
          case OPS.setHScale:
            hScale = (Number(args?.[0]) || 100) / 100
            break
          case OPS.setTextMatrix: {
            const m = asMatrix(args?.[0]) ?? asMatrix(args)
            if (m) {
              tlm = m
              tm = [...m]
            }
            break
          }
          case OPS.moveText:
            moveLine(Number(args?.[0]) || 0, Number(args?.[1]) || 0)
            break
          case OPS.setLeadingMoveText:
            leading = -(Number(args?.[1]) || 0)
            moveLine(Number(args?.[0]) || 0, Number(args?.[1]) || 0)
            break
          case OPS.nextLine:
            moveLine(0, -leading)
            break
          case OPS.showText:
          case OPS.showSpacedText:
            show((args?.[0] as (Glyph | number | null)[]) ?? [])
            break
        }
      }
      flush()
      page.cleanup()
    }
  } finally {
    await close()
  }
  return [out.join('\n'), redChars]
}
