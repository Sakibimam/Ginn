// Speech-to-text with whisper.cpp running on this machine. Free, offline, nothing leaves the laptop.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { config } from './config.js'

const run = promisify(execFile)

/** Wrap raw PCM s16le 16 kHz mono (what G2 sends) in a WAV header. */
export function pcmToWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

async function tmpFile(ext: string) {
  return path.join(os.tmpdir(), `ginn-${crypto.randomBytes(6).toString('hex')}.${ext}`)
}

// Whisper is CPU-heavy: run at most N at once and queue the rest, so one busy minute doesn't stall everyone.
let running = 0
const waiting: (() => void)[] = []
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= config.sttConcurrency) await new Promise<void>(res => waiting.push(res))
  running++
  try {
    return await fn()
  } finally {
    running--
    waiting.shift()?.()
  }
}

// ── persistent whisper-server: loads the model once instead of on every request ──
let server: ChildProcess | null = null
let serverReady = false

export async function startWhisperServer() {
  if (!existsSync(config.whisperModel)) {
    console.warn(`[stt] whisper model not found at ${config.whisperModel}. Voice won't work until you download it (see README). Typing still works.`)
    return
  }
  if (config.whisperMode !== 'server') return
  const url = `http://127.0.0.1:${config.whisperPort}`
  try {
    server = spawn(config.whisperServerBin, ['-m', config.whisperModel, '--host', '127.0.0.1', '--port', String(config.whisperPort), '-l', 'en', '-nt'], { stdio: 'ignore' })
  } catch {
    return
  }
  server.on('error', () => {
    serverReady = false
    server = null
  })
  server.on('exit', () => {
    serverReady = false
    server = null
  })
  for (let i = 0; i < 60 && server; i++) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) })
      serverReady = true
      console.log('[stt] whisper model loaded (server mode)')
      return
    } catch {
      await new Promise(r => setTimeout(r, 500))
    }
  }
  console.warn('[stt] whisper-server did not start; using whisper-cli per request')
}

export function stopWhisperServer() {
  server?.kill()
}

const clean = (t: string) => t.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()

async function viaServer(wavPath: string): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([await fs.readFile(wavPath)], { type: 'audio/wav' }), 'audio.wav')
  form.append('response_format', 'json')
  form.append('temperature', '0')
  const r = await fetch(`http://127.0.0.1:${config.whisperPort}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) })
  if (!r.ok) throw new Error(`whisper-server ${r.status}`)
  return clean(((await r.json()) as { text?: string }).text ?? '')
}

/** Transcribe a WAV (16 kHz mono) file. */
function whisper(wavPath: string): Promise<string> {
  if (serverReady)
    return viaServer(wavPath).catch(e => {
      console.warn('[stt] server failed, falling back to cli:', (e as Error).message)
      return slot(() => runWhisper(wavPath))
    })
  return slot(() => runWhisper(wavPath))
}

async function runWhisper(wavPath: string): Promise<string> {
  const { stdout } = await run(
    config.whisperBin,
    ['-m', config.whisperModel, '-f', wavPath, '-nt', '-np', '-l', 'en'],
    { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
  )
  // whisper marks silence and noise as [BLANK_AUDIO], (music) etc.
  return clean(stdout)
}

export async function transcribePcm(pcm: Buffer): Promise<string> {
  if (pcm.length < 16000 * 2 * 0.4) return ''
  // Cap at the configured length (16 kHz × 2 bytes per sample).
  if (pcm.length > 32000 * config.maxListenSeconds) pcm = pcm.subarray(0, 32000 * config.maxListenSeconds)
  const wav = await tmpFile('wav')
  await fs.writeFile(wav, pcmToWav(pcm), { mode: 0o600 })
  try {
    return await whisper(wav)
  } finally {
    fs.rm(wav, { force: true })
  }
}

/** Any browser recording (webm/ogg/mp4) → 16 kHz mono WAV via ffmpeg → whisper. */
export async function transcribeAny(data: Buffer, ext = 'webm'): Promise<string> {
  const input = await tmpFile(ext)
  const wav = await tmpFile('wav')
  await fs.writeFile(input, data, { mode: 0o600 })
  try {
    await run(config.ffmpegBin, ['-y', '-loglevel', 'error', '-i', input, '-t', String(config.maxListenSeconds), '-ar', '16000', '-ac', '1', wav], { timeout: 60_000 })
    return await whisper(wav)
  } finally {
    fs.rm(input, { force: true })
    fs.rm(wav, { force: true })
  }
}
