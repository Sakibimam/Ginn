// Speech-to-text with whisper.cpp running on this machine. Free, offline, nothing leaves the laptop.
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
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

/** Transcribe a WAV (16 kHz mono) file. */
async function whisper(wavPath: string): Promise<string> {
  const { stdout } = await run(
    config.whisperBin,
    ['-m', config.whisperModel, '-f', wavPath, '-nt', '-np', '-l', 'en'],
    { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
  )
  return stdout.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim()
}

export async function transcribePcm(pcm: Buffer): Promise<string> {
  if (pcm.length < 16000 * 2 * 0.4) throw new Error('Too short: hold for at least half a second')
  const wav = await tmpFile('wav')
  await fs.writeFile(wav, pcmToWav(pcm))
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
  await fs.writeFile(input, data)
  try {
    await run(config.ffmpegBin, ['-y', '-loglevel', 'error', '-i', input, '-ar', '16000', '-ac', '1', wav], { timeout: 60_000 })
    return await whisper(wav)
  } finally {
    fs.rm(input, { force: true })
    fs.rm(wav, { force: true })
  }
}
