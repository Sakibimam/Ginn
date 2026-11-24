import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(here, '..')
export const DATA_DIR = path.join(ROOT, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })

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
  whisperModel: (process.env.WHISPER_MODEL || '~/.cache/whisper/ggml-small.en.bin').replace(/^~(?=\/)/, process.env.HOME ?? ''),
  ffmpegBin: process.env.FFMPEG_BIN ?? 'ffmpeg',
  // 'server' keeps the model loaded in a whisper-server child process (fast); 'cli' runs whisper-cli per request.
  whisperMode: (process.env.WHISPER_MODE ?? 'server') as 'server' | 'cli',
  whisperServerBin: process.env.WHISPER_SERVER_BIN ?? 'whisper-server',
  whisperPort: Number(process.env.WHISPER_PORT ?? 8178),

  // Telegram (user account). Without these, Ginn runs on a mock Telegram.
  tgApiId: Number(process.env.TG_API_ID ?? 0),
  tgApiHash: process.env.TG_API_HASH ?? '',

  // Google Calendar (OAuth web client, testing mode).
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',

  // Seconds a message waits in Telegram's scheduled queue so you can undo it.
  undoSeconds: num(process.env.GINN_UNDO_SECONDS, 20, 1, 300),
  // Longest debrief the lens records.
  maxListenSeconds: num(process.env.GINN_MAX_LISTEN_SECONDS, 45, 10, 120),

  // Requests from this machine skip the pairing token (simulator, local browser). Set false behind a local reverse proxy.
  trustLocal: process.env.GINN_TRUST_LOCAL !== 'false',
  // Ginn Lite is public: cap how much it can cost you.
  liteMaxPerHour: num(process.env.GINN_LITE_MAX_PER_HOUR, 200, 0, 100000),
  litePerIpPerHour: num(process.env.GINN_LITE_PER_IP_PER_HOUR, 20, 1, 1000),
  // Parallel whisper runs. More than the CPU can take makes every request slow.
  sttConcurrency: num(process.env.GINN_STT_CONCURRENCY, 2, 1, 8),
}

function num(v: string | undefined, def: number, min: number, max: number) {
  const n = Number(v)
  return Number.isFinite(n) && v !== undefined && v !== '' ? Math.min(max, Math.max(min, n)) : def
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
