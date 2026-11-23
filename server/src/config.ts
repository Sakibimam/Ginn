import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(here, '..')
export const DATA_DIR = path.join(ROOT, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

/** Local secret used to encrypt the Telegram session and Google tokens at rest. */
function loadSecret(): Buffer {
  const fromEnv = process.env.GINN_SECRET
  if (fromEnv) return crypto.createHash('sha256').update(fromEnv).digest()
  const file = path.join(DATA_DIR, 'secret.key')
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 })
  }
  return crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8').trim()).digest()
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  secret: loadSecret(),

  // AI parser. Without a key Ginn uses its built-in rules parser (free, offline).
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
  model: process.env.GINN_MODEL ?? 'claude-opus-5-5',

  // Speech-to-text: local whisper.cpp
  whisperBin: process.env.WHISPER_BIN ?? 'whisper-cli',
  whisperModel: process.env.WHISPER_MODEL ?? path.join(process.env.HOME ?? '', '.cache/whisper/ggml-small.en.bin'),
  ffmpegBin: process.env.FFMPEG_BIN ?? 'ffmpeg',

  // Telegram (user account). Without these, Ginn runs on a mock Telegram.
  tgApiId: Number(process.env.TG_API_ID ?? 0),
  tgApiHash: process.env.TG_API_HASH ?? '',

  // Google Calendar (OAuth web client, testing mode).
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',

  // Seconds a message waits in Telegram's scheduled queue so you can undo it.
  undoSeconds: Number(process.env.GINN_UNDO_SECONDS ?? 20),
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', config.secret, iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.')
}

export function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split('.').map(s => Buffer.from(s, 'base64'))
  const d = crypto.createDecipheriv('aes-256-gcm', config.secret, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8')
}
