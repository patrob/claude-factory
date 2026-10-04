// Factory floor picture: the one word the pane shows, drawn as pixels.
// Pure functions, no `$`: floor.tsx hands these to Raster and Image on the terminal
// and to Svg on the desktop. Colors are 0xRRGGBB.

import type { FloorSnapshot } from '../types'
import type { FloorAttention } from './floor-model'

// The runtime has these (ES2026); the es2023 lib the plugin's tsconfig names does not.
declare global {
  interface Uint8Array {
    toBase64(): string
  }
  interface Uint8ArrayConstructor {
    fromBase64(text: string): Uint8Array
  }
}

export type FloorPicture = {
  // The short word in the picture, also its alt text.
  word: string
  field: number
  lamp: number
  ink: number
  // The attention tone (or the running/idle color when nothing needs a person).
  tone: number
}

const FIELD_RUNNING = 0x14532d
const FIELD_IDLE = 0x1e293b
const LAMP_RUNNING = 0x4ade80
const LAMP_IDLE = 0x475569
const INK_RUNNING = 0xdcfce7
const INK_IDLE = 0x94a3b8
const TONES = { red: 0xf87171, yellow: 0xfacc15, cyan: 0x22d3ee } as const

const STAGE_WORDS: Record<FloorSnapshot['current'], string> = {
  ready: 'NEXT',
  claim: 'NEXT',
  plan: 'PLAN',
  worktree: 'TREE',
  check: 'TEST',
  evidence: 'PACK',
  pr: 'OPEN',
  merge: 'MERGE',
}

export function pictureOf(f: FloorSnapshot | null, att: FloorAttention | null, running: boolean): FloorPicture {
  const base = {
    field: running ? FIELD_RUNNING : FIELD_IDLE,
    lamp: running ? LAMP_RUNNING : LAMP_IDLE,
  }
  if (!f || !att) {
    const ink = running ? INK_RUNNING : INK_IDLE
    return { ...base, word: running ? 'LIVE' : 'IDLE', ink, tone: running ? LAMP_RUNNING : LAMP_IDLE }
  }
  const word = f.hardStop
    ? 'STOP'
    : f.evidence.lastResult === 'fail'
      ? 'FAIL'
      : STAGE_WORDS[f.current]
  const tone = TONES[att.tone]
  return { ...base, word, ink: tone, tone }
}

// 3x5 capitals, top row first.
const FONT: Record<string, readonly string[]> = {
  A: ['010', '101', '111', '101', '101'],
  C: ['011', '100', '100', '100', '011'],
  D: ['110', '101', '101', '101', '110'],
  E: ['111', '100', '110', '100', '111'],
  F: ['111', '100', '110', '100', '100'],
  G: ['011', '100', '101', '101', '011'],
  I: ['111', '010', '010', '010', '111'],
  K: ['101', '101', '110', '101', '101'],
  L: ['100', '100', '100', '100', '111'],
  M: ['101', '111', '111', '101', '101'],
  N: ['110', '101', '101', '101', '101'],
  O: ['010', '101', '101', '101', '010'],
  P: ['110', '101', '110', '100', '100'],
  R: ['110', '101', '110', '101', '101'],
  S: ['011', '100', '010', '001', '110'],
  T: ['111', '010', '010', '010', '010'],
  V: ['101', '101', '101', '101', '010'],
  X: ['101', '101', '010', '101', '101'],
}

const LAMP = ['01110', '11111', '11111', '11111', '01110']
const WORD_X = 9
const PIXEL_ROWS = 16
export const RASTER_ROWS = PIXEL_ROWS / 2

// How wide the word is at a horizontal scale, one pixel between letters.
function wordWidth(word: string, sx: number): number {
  return word.length * 3 * sx + Math.max(0, word.length - 1)
}

// Columns the raster takes for this word: about 36, wider for a five-letter word, never past `room`.
export function rasterColumns(word: string, room: number): number {
  const wide = WORD_X + wordWidth(word, 2) + 2
  return Math.max(1, Math.min(Math.max(36, wide), room))
}

function pack(nums: number[]): string {
  return new Uint8Array(Uint32Array.from(nums).buffer).toBase64()
}

// Half-block cells (U+2580): foreground is the top pixel, background the bottom one.
export function rasterCells(p: FloorPicture, columns: number): string {
  const px: number[][] = Array.from({ length: PIXEL_ROWS }, () => Array<number>(columns).fill(p.field))
  const put = (x: number, y: number, c: number) => {
    const row = px[y]
    if (row && x >= 0 && x < columns) row[x] = c
  }
  LAMP.forEach((line, dy) => [...line].forEach((bit, dx) => bit === '1' && put(2 + dx, 5 + dy, p.lamp)))
  if (p.lamp === LAMP_RUNNING) put(3, 6, INK_RUNNING)
  const sx = WORD_X + wordWidth(p.word, 2) <= columns ? 2 : 1
  let x = WORD_X
  for (const ch of p.word) {
    const glyph = FONT[ch] ?? []
    glyph.forEach((line, gy) =>
      [...line].forEach((bit, gx) => {
        if (bit !== '1') return
        for (let i = 0; i < sx; i++) for (let j = 0; j < 2; j++) put(x + gx * sx + i, 3 + gy * 2 + j, p.ink)
      }),
    )
    x += 3 * sx + 1
  }
  if (p.tone !== p.lamp) for (let i = 0; i < columns; i++) put(i, PIXEL_ROWS - 1, p.tone)
  const nums: number[] = []
  for (let cy = 0; cy < RASTER_ROWS; cy++) {
    for (let cx = 0; cx < columns; cx++) nums.push(0x2580, px[cy * 2]?.[cx] ?? p.field, px[cy * 2 + 1]?.[cx] ?? p.field)
  }
  return pack(nums)
}

const BADGE_PX = 16

// A filled rounded square in the tone, raw RGBA for Image.
export function badgeRgba(p: FloorPicture): { rgba: string; width: number; height: number } {
  const bytes = new Uint8Array(BADGE_PX * BADGE_PX * 4)
  const r = (p.tone >> 16) & 0xff
  const g = (p.tone >> 8) & 0xff
  const b = p.tone & 0xff
  for (let y = 0; y < BADGE_PX; y++) {
    for (let x = 0; x < BADGE_PX; x++) {
      const dx = Math.max(0, 3 - x, x - (BADGE_PX - 4))
      const dy = Math.max(0, 3 - y, y - (BADGE_PX - 4))
      if (dx * dx + dy * dy > 9) continue
      bytes.set([r, g, b, 0xff], (y * BADGE_PX + x) * 4)
    }
  }
  return { rgba: bytes.toBase64(), width: BADGE_PX, height: BADGE_PX }
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`

// The desktop's drawing of the same picture: field, lamp, word.
export function svgMarkup(p: FloorPicture): string {
  const bar = p.tone !== p.lamp ? `<rect x="0" y="88" width="360" height="8" fill="${hex(p.tone)}"/>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="96" viewBox="0 0 360 96">` +
    `<rect width="360" height="96" rx="10" fill="${hex(p.field)}"/>${bar}` +
    `<circle cx="44" cy="48" r="18" fill="${hex(p.lamp)}"/>` +
    `<text x="84" y="68" font-family="ui-monospace, Menlo, monospace" font-size="56" font-weight="700" letter-spacing="6" fill="${hex(p.ink)}">${p.word}</text>` +
    `</svg>`
  )
}
