import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import { secureHeaders } from 'hono/secure-headers'
import { serve } from '@hono/node-server'
import { DateTime } from 'luxon'
import { z } from 'zod'
import { config, DATA_DIR, ROOT } from './config.js'
import { db, save, saveNow } from './store.js'
import { transcribeAny, transcribePcm, startWhisperServer, stopWhisperServer } from './stt.js'
import { parseDebrief } from './parse.js'
import { calendar } from './calendar.js'
import * as engine from './engine.js'
import type { Settings } from './types.js'

// ───────────────────────── auth: pairing code → token ─────────────────────────
const TOKEN_FILE = path.join(DATA_DIR, 'token')
const token = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : crypto.randomBytes(32).toString('hex')
fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 })

/** A 6-digit code that lives 15 minutes and dies after one use. */
const PAIR_TTL = 15 * 60_000
let pairing = { code: '', expires: 0 }
function pairingCode() {
  if (Date.now() > pairing.expires) {
    pairing = { code: String(crypto.randomInt(100000, 1000000)), expires: Date.now() + PAIR_TTL }
    console.log(`  Pairing code: ${pairing.code} (valid 15 min)`)
  }
  return pairing.code
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

function clientIp(c: Context) {
  const fwd = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]
  const addr = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming?.socket?.remoteAddress ?? ''
  return (fwd || addr || 'unknown').trim()
}

/** Requests from this machine (simulator, local browser) skip the token. Anything via a tunnel or the LAN needs it. */
function isLocal(c: Context) {
  if (!config.trustLocal) return false
  const forwarded = c.req.header('x-forwarded-for') || c.req.header('cf-connecting-ip') || c.req.header('forwarded')
  const addr = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming?.socket?.remoteAddress ?? ''
  return !forwarded && /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(addr)
}

function authed(c: Context) {
  if (isLocal(c)) return true
  const h = c.req.header('authorization') ?? ''
  return h.startsWith('Bearer ') && safeEqual(h.slice(7), token)
}

/** Sliding-window counter: true if `key` is still under `max` hits in `windowMs`. */
const windows = new Map<string, number[]>()
function allow(key: string, max: number, windowMs: number) {
  const now = Date.now()
  const hits = (windows.get(key) ?? []).filter(t => now - t < windowMs)
  if (hits.length >= max) {
    windows.set(key, hits)
    return false
  }
  hits.push(now)
  windows.set(key, hits)
  if (windows.size > 10_000) for (const [k, v] of windows) if (!v.some(t => now - t < windowMs)) windows.delete(k)
  return true
}

// ───────────────────────── app ─────────────────────────
const app = new Hono()

app.use('*', secureHeaders({ contentSecurityPolicy: undefined, crossOriginResourcePolicy: false }))
app.use('/api/*', cors({ origin: '*', allowHeaders: ['content-type', 'authorization', 'x-ginn-anon'], allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'], maxAge: 600 }))

// Audio up to ~2 minutes of browser audio; everything else is small JSON.
const AUDIO_MAX = 8 * 1024 * 1024
const tooBig = (c: Context) => c.json({ error: 'Too large' }, 413)
app.use('/api/debrief/pcm', bodyLimit({ maxSize: AUDIO_MAX, onError: tooBig }))
app.use('/api/debrief/audio', bodyLimit({ maxSize: AUDIO_MAX, onError: tooBig }))
app.use('/api/lite/debrief', bodyLimit({ maxSize: AUDIO_MAX, onError: tooBig }))
app.use('/api/*', async (c, next) => {
  if (/\/api\/(debrief\/(pcm|audio)|lite\/debrief)$/.test(c.req.path)) return next()
  return bodyLimit({ maxSize: 64 * 1024, onError: tooBig })(c, next)
})

const PUBLIC = ['/api/pair', '/api/health', '/api/lite/']
app.use('/api/*', async (c, next) => {
  if (c.req.method === 'OPTIONS' || PUBLIC.some(p => c.req.path.startsWith(p)) || authed(c)) return next()
  return c.json({ error: 'Pair this device first' }, 401)
})

app.onError((err, c) => {
  if (err instanceof z.ZodError) return c.json({ error: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, 400)
  if (err instanceof SyntaxError) return c.json({ error: 'Invalid JSON' }, 400)
  const status = err instanceof engine.HttpError ? err.status : 500
  if (status === 500) console.error('[http]', c.req.method, c.req.path, err)
  return c.json({ error: status === 500 ? 'Something went wrong on the server' : err.message }, status as 400)
})

async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  return schema.parse(await c.req.json().catch(() => ({})))
}

// ── pairing + health ──
app.post('/api/pair', async c => {
  const ip = clientIp(c)
  if (!allow(`pair:${ip}`, 5, 10 * 60_000) || !allow('pair:all', 30, 10 * 60_000)) return c.json({ error: 'Too many tries. Wait 10 minutes.' }, 429)
  const { code } = await body(c, z.object({ code: z.string().trim().regex(/^\d{6}$/, 'six digits') }))
  if (!pairing.code || Date.now() > pairing.expires || !safeEqual(code, pairing.code)) return c.json({ error: 'Wrong or expired code' }, 403)
  pairing = { code: '', expires: 0 } // one use
  return c.json({ token })
})

app.get('/api/health', async c => {
  const tg = engine.getTelegram()
  const s = db.settings
  return c.json({
    ok: true,
    parser: config.anthropicKey ? `claude (${config.model})` : 'rules (offline)',
    telegram: { configured: Boolean(tg), connected: Boolean(tg) && engine.getChannel().connected(), mock: !tg, me: authed(c) ? await engine.getChannel().me().catch(() => null) : undefined },
    calendar: { configured: calendar.configured(), connected: calendar.connected() },
    undoSeconds: config.undoSeconds,
    maxListenSeconds: config.maxListenSeconds,
    setupNeeded: !s.myName && !s.myCompany,
    paired: authed(c),
    pairingCode: isLocal(c) ? pairingCode() : undefined,
  })
})

// ── settings ──
const SettingsPatch = z
  .object({
    myName: z.string().trim().max(60),
    myCompany: z.string().trim().max(60),
    defaultEvent: z.string().trim().max(80),
    timezone: z.string().refine(tz => DateTime.local().setZone(tz).isValid, 'unknown time zone'),
    dmTiming: z.enum(['now', 'morning']),
    autoSelf: z.boolean(),
    snippets: z.record(z.string().trim().min(1).max(60), z.string().trim().url().max(500)).refine(o => Object.keys(o).length <= 50, 'at most 50'),
    meetingHour: z.number().int().min(0).max(23),
    meetingMinutes: z.number().int().min(5).max(480),
    reminderLeadMinutes: z.number().int().min(0).max(1440),
    groupTitle: z.string().trim().min(1).max(80),
  })
  .partial()

app.get('/api/settings', c => c.json(db.settings))
app.put('/api/settings', async c => {
  const patch = await body(c, SettingsPatch)
  Object.assign(db.settings, patch as Partial<Settings>)
  save()
  return c.json(db.settings)
})

// ── debriefs ──
const view = (d: ReturnType<typeof engine.getDraft>) => ({
  ...engine.refresh(d),
  actions: d.actions.map(a => ({ ...a, refs: undefined, when: engine.whenLabel(a.at) })),
})
// Whisper invents these on silence or noise. A real debrief has at least a name and a few words.
const PHANTOM = /^(you|thank you|thanks|thanks for watching|bye|okay|ok|so|um+|uh+|hmm+|music)[.!? ]*$/i
const heard = (text: string) => {
  const t = text.trim()
  if (!t || PHANTOM.test(t) || t.split(/\s+/).length < 2) throw new engine.HttpError(422, "Didn't catch that. Tap and say who you met, then what you promised.")
  return t.slice(0, 1000)
}

app.post('/api/debrief/pcm', async c => {
  const pcm = Buffer.from(await c.req.arrayBuffer())
  const text = heard(await stt(() => transcribePcm(pcm)))
  return c.json(view(await engine.createDraft(text, 'glasses')))
})

app.post('/api/debrief/audio', async c => {
  const ext = (c.req.query('ext') ?? 'webm').replace(/[^a-z0-9]/g, '').slice(0, 5) || 'webm'
  const audio = Buffer.from(await c.req.arrayBuffer())
  const text = heard(await stt(() => transcribeAny(audio, ext)))
  return c.json(view(await engine.createDraft(text, 'phone')))
})

app.post('/api/debrief/text', async c => {
  const { text, source } = await body(c, z.object({ text: z.string().trim().min(3).max(1000), source: z.enum(['glasses', 'phone', 'text']).optional() }))
  return c.json(view(await engine.createDraft(text, source ?? 'text')))
})

/** Turn "whisper isn't installed" into a message a person can act on. */
async function stt(fn: () => Promise<string>) {
  try {
    return await fn()
  } catch (e) {
    console.error('[stt]', (e as Error).message)
    throw new engine.HttpError(503, 'Speech-to-text is not working on the server. Check whisper.cpp and the model (see README), or type instead.')
  }
}

const Id = z.string().regex(/^[a-z0-9]{6,32}$/i)
app.get('/api/drafts', c => c.json(db.drafts.slice(0, 50).map(view)))
app.get('/api/drafts/:id', c => c.json(view(engine.getDraft(Id.parse(c.req.param('id'))))))
app.post('/api/drafts/:id/pick', async c => {
  const { contactId, actionId } = await body(c, z.object({ contactId: z.string().min(1).max(64), actionId: Id.optional() }))
  return c.json(view(await engine.pick(Id.parse(c.req.param('id')), contactId, actionId)))
})
app.post('/api/drafts/:id/toggle', async c => {
  const { actionId, approved } = await body(c, z.object({ actionId: Id, approved: z.boolean().optional() }))
  return c.json(view(engine.toggle(Id.parse(c.req.param('id')), actionId, approved)))
})
app.post('/api/drafts/:id/edit', async c => {
  const { actionId, text } = await body(c, z.object({ actionId: Id, text: z.string().trim().min(1).max(1000) }))
  return c.json(view(engine.editAction(Id.parse(c.req.param('id')), actionId, text)))
})
app.post('/api/drafts/:id/approve', async c => c.json(view(await engine.approve(Id.parse(c.req.param('id'))))))
app.post('/api/drafts/:id/discard', c => c.json(view(engine.discard(Id.parse(c.req.param('id'))))))
app.post('/api/drafts/:id/undo', async c => {
  const { actionId } = await body(c, z.object({ actionId: Id.optional() }))
  const id = Id.parse(c.req.param('id'))
  return c.json(view(actionId ? await engine.undo(id, actionId) : await engine.undoAll(id)))
})

app.get('/api/contacts/search', async c => c.json(await engine.searchContacts((c.req.query('q') ?? '').slice(0, 60))))
app.get('/api/today', c => {
  const t = engine.today()
  return c.json({ ...t, drafts: t.drafts.map(view) })
})
app.get('/api/next', c => c.json(engine.nextMeeting()))
app.get('/api/before/:contactId', c => c.json(engine.before(c.req.param('contactId').slice(0, 64))))
app.get('/api/outbox', c => c.json(db.outbox.slice(0, 50)))

// ── Telegram login (typed by the user on their own setup page; never stored except as the encrypted session) ──
const tgOrFail = () => {
  const tg = engine.getTelegram()
  if (!tg) throw new engine.HttpError(400, 'Set TG_API_ID and TG_API_HASH in server/.env first')
  return tg
}
const loginGuard = (c: Context) => {
  if (!allow(`tg:${clientIp(c)}`, 10, 15 * 60_000)) throw new engine.HttpError(429, 'Too many login attempts. Wait 15 minutes.')
}
app.post('/api/tg/start', async c => {
  loginGuard(c)
  const { phone } = await body(c, z.object({ phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'phone number with country code') }))
  return c.json(await tgOrFail().startLogin(phone.replace(/[^\d+]/g, '')))
})
app.post('/api/tg/code', async c => {
  loginGuard(c)
  const { code } = await body(c, z.object({ code: z.string().trim().regex(/^\d{4,8}$/, 'the code from Telegram') }))
  const result = await tgOrFail().submitCode(code)
  if (result === 'ok') engine.warmContacts()
  return c.json({ result })
})
app.post('/api/tg/password', async c => {
  loginGuard(c)
  const { password } = await body(c, z.object({ password: z.string().min(1).max(256) }))
  await tgOrFail().submitPassword(password)
  engine.warmContacts()
  return c.json({ result: 'ok' })
})
app.post('/api/tg/logout', async c => {
  await tgOrFail().logout()
  return c.json({ ok: true })
})

// ── Google Calendar sign-in on a separate page (Google sign-in doesn't work inside the G2 WebView) ──
app.get('/auth/google/start', c => {
  // Only the owner may link a calendar: from this machine, or with the token in the link.
  if (!isLocal(c) && !safeEqual(c.req.query('t') ?? '', token)) return c.text('Open this from the computer running Ginn.', 403)
  if (!calendar.configured()) return c.text('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server/.env first', 400)
  return c.redirect(calendar.authUrl())
})
app.get('/auth/google/callback', async c => {
  try {
    await calendar.handleCallback(c.req.query('code') ?? '', c.req.query('state') ?? '')
    return c.html(page('done.html').replace('{{message}}', 'Google Calendar connected. You can close this tab.'))
  } catch (e) {
    return c.html(page('done.html').replace('{{message}}', `Google sign-in failed: ${escapeHtml((e as Error).message)}`), 400)
  }
})
app.post('/api/google/disconnect', c => {
  calendar.disconnect()
  return c.json({ ok: true })
})

// ───────────────────────── Ginn Lite: public, no login, nothing sent on anyone's behalf ─────────────────────────
function ics(title: string, startUtc: string, minutes: number, desc: string) {
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const s = new Date(startUtc)
  const e = new Date(s.getTime() + minutes * 60_000)
  const esc = (t: string) => t.replace(/[\\,;]/g, m => `\\${m}`).replace(/\r?\n/g, '\\n')
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ginn//EN', 'BEGIN:VEVENT', `UID:${crypto.randomUUID()}@ginn`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(s)}`, `DTEND:${f(e)}`, `SUMMARY:${esc(title)}`, `DESCRIPTION:${esc(desc)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
}

const MAX_LITE_USERS = 50_000
app.post('/api/lite/debrief', async c => {
  if (!allow(`lite:${clientIp(c)}`, config.litePerIpPerHour, 3600_000)) return c.json({ error: 'You have used Ginn Lite a lot this hour. Try again later.' }, 429)
  if (!allow('lite:all', config.liteMaxPerHour, 3600_000)) return c.json({ error: 'Ginn Lite is busy. Try again in a bit.' }, 429)
  const anon = (c.req.header('x-ginn-anon') ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 24) || 'anon'
  const q = c.req.query()
  let text: string
  if ((c.req.header('content-type') ?? '').includes('json')) text = (await body(c, z.object({ text: z.string().trim().max(1000) }))).text
  else {
    const audio = Buffer.from(await c.req.arrayBuffer())
    text = await stt(() => transcribeAny(audio, (q.ext ?? 'webm').replace(/[^a-z0-9]/g, '').slice(0, 5) || 'webm'))
  }
  text = heard(text.trim())
  const tz = q.tz && DateTime.local().setZone(q.tz).isValid ? q.tz : db.settings.timezone
  const s: Settings = {
    ...db.settings,
    myName: (q.name ?? '').slice(0, 40),
    myCompany: (q.company ?? '').slice(0, 40),
    defaultEvent: (q.event ?? '').slice(0, 60),
    timezone: tz,
    snippets: {},
  }
  const p = await parseDebrief(text, s)
  if (db.lite[anon] || Object.keys(db.lite).length < MAX_LITE_USERS) {
    const u = (db.lite[anon] ??= { debriefs: 0, shares: 0, first: new Date().toISOString(), last: '' })
    u.debriefs++
    u.last = new Date().toISOString()
    save()
  }
  return c.json({
    transcript: text,
    person: p.personName,
    company: p.company,
    actions: p.actions.map(a => {
      const at = a.when ? DateTime.fromISO(a.when, { zone: tz }).toUTC().toISO() : null
      return {
        kind: a.kind,
        text: a.text,
        otherName: a.otherName,
        when: a.when ? DateTime.fromISO(a.when).toFormat('ccc d LLL, HH:mm') : 'now',
        share: a.kind === 'dm' || a.kind === 'intro' ? `https://t.me/share/url?url=${encodeURIComponent(' ')}&text=${encodeURIComponent(a.text)}` : undefined,
        ics: a.kind === 'meeting' && at ? `data:text/calendar;charset=utf-8,${encodeURIComponent(ics(a.text, at, s.meetingMinutes, text))}` : undefined,
      }
    }),
  })
})

app.post('/api/lite/share', c => {
  const anon = (c.req.header('x-ginn-anon') ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 24)
  if (anon && db.lite[anon] && allow(`share:${anon}`, 60, 3600_000)) {
    db.lite[anon].shares++
    save()
  }
  return c.json({ ok: true })
})

app.get('/api/lite/stats', c => {
  const users = Object.values(db.lite)
  return c.json({ users: users.length, repeatUsers: users.filter(u => u.debriefs > 1).length, debriefs: users.reduce((n, u) => n + u.debriefs, 0), shares: users.reduce((n, u) => n + u.shares, 0) })
})

// ───────────────────────── pages ─────────────────────────
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!)
const pages = new Map<string, string>()
const page = (f: string) => {
  if (!pages.has(f) || process.env.NODE_ENV !== 'production') pages.set(f, fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'))
  return pages.get(f)!
}
// The setup page controls your accounts, so it is only served on the machine running Ginn.
app.get('/', c => (isLocal(c) ? c.html(page('index.html')) : c.redirect('/lite')))
app.get('/lite', c => c.html(page('lite.html')))
app.get('/favicon.svg', c => c.body(page('favicon.svg'), 200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' }))
app.notFound(c => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found' }, 404) : c.redirect('/lite')))

// ───────────────────────── start ─────────────────────────
await Promise.all([engine.initChannel(), startWhisperServer()])
engine.recover()
serve({ fetch: app.fetch, port: config.port, hostname: config.host }, info => {
  console.log(`\n  Ginn server on http://localhost:${info.port}  (setup page: open it on this computer)`)
  console.log(`  Parser: ${config.anthropicKey ? `Claude (${config.model})` : 'rules (offline): set ANTHROPIC_API_KEY to use Claude'}`)
  console.log(`  Telegram: ${engine.getTelegram() ? 'your account' : 'mock (set TG_API_ID / TG_API_HASH)'} · Calendar: ${calendar.connected() ? 'connected' : 'off'}`)
  pairingCode()
  console.log('')
})

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    try {
      stopWhisperServer()
      saveNow()
    } finally {
      process.exit(0)
    }
  })
