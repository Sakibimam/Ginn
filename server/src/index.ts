import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { DateTime } from 'luxon'
import { config, DATA_DIR, ROOT } from './config.js'
import { db, save, saveNow } from './store.js'
import { transcribeAny, transcribePcm } from './stt.js'
import { parseDebrief } from './parse.js'
import { calendar } from './calendar.js'
import * as engine from './engine.js'
import type { Settings } from './types.js'

// ── pairing: the server prints a 6-digit code; the app trades it for a token ──
const TOKEN_FILE = path.join(DATA_DIR, 'token')
const token = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : crypto.randomBytes(24).toString('hex')
fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 })
const pairingCode = String(crypto.randomInt(100000, 999999))

const app = new Hono()
app.use('/api/*', cors({ origin: '*', allowHeaders: ['content-type', 'authorization', 'x-ginn-anon'], allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'] }))

/** Requests from this machine (simulator, local browser) need no token; anything through a tunnel or LAN does. */
function isLocal(c: Context) {
  const forwarded = c.req.header('x-forwarded-for') || c.req.header('cf-connecting-ip')
  const addr = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming?.socket?.remoteAddress ?? ''
  return !forwarded && /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(addr)
}

const open = ['/api/pair', '/api/health', '/api/lite/']
app.use('/api/*', async (c, next) => {
  if (c.req.method === 'OPTIONS' || open.some(p => c.req.path.startsWith(p)) || isLocal(c)) return next()
  if (c.req.header('authorization') === `Bearer ${token}`) return next()
  return c.json({ error: 'Pair this device first' }, 401)
})

app.onError((err, c) => {
  const status = err instanceof engine.HttpError ? err.status : 500
  if (status === 500) console.error(err)
  return c.json({ error: err.message }, status as 400)
})

app.post('/api/pair', async c => {
  const { code } = await c.req.json<{ code: string }>()
  if (String(code).trim() !== pairingCode) return c.json({ error: 'Wrong code' }, 403)
  return c.json({ token })
})

app.get('/api/health', async c => {
  const tg = engine.getTelegram()
  return c.json({
    ok: true,
    parser: config.anthropicKey ? `claude (${config.model})` : 'rules (offline)',
    telegram: { configured: Boolean(tg), connected: engine.getChannel().connected() && Boolean(tg), mock: !tg, me: await engine.getChannel().me().catch(() => null) },
    calendar: { configured: calendar.configured(), connected: calendar.connected() },
    pairingCode: isLocal(c) ? pairingCode : undefined,
  })
})

app.get('/api/settings', c => c.json(db.settings))
app.put('/api/settings', async c => {
  const body = await c.req.json<Partial<Settings>>()
  const allowed: (keyof Settings)[] = ['myName', 'myCompany', 'timezone', 'defaultEvent', 'dmTiming', 'autoSelf', 'snippets']
  for (const k of allowed) if (k in body) (db.settings as unknown as Record<string, unknown>)[k] = body[k]
  save()
  return c.json(db.settings)
})

// ── debriefs ──
const view = (d: ReturnType<typeof engine.getDraft>) => ({
  ...engine.refresh(d),
  actions: d.actions.map(a => ({ ...a, refs: undefined, when: engine.whenLabel(a.at) })),
})

app.post('/api/debrief/pcm', async c => {
  const pcm = Buffer.from(await c.req.arrayBuffer())
  const text = await transcribePcm(pcm)
  if (!text) return c.json({ error: "Didn't catch that" }, 422)
  return c.json(view(await engine.createDraft(text, 'glasses')))
})

app.post('/api/debrief/audio', async c => {
  const ext = (c.req.query('ext') ?? 'webm').replace(/[^a-z0-9]/g, '')
  const text = await transcribeAny(Buffer.from(await c.req.arrayBuffer()), ext)
  if (!text) return c.json({ error: "Didn't catch that" }, 422)
  return c.json(view(await engine.createDraft(text, 'phone')))
})

app.post('/api/debrief/text', async c => {
  const { text, source } = await c.req.json<{ text: string; source?: 'glasses' | 'phone' | 'text' }>()
  if (!text?.trim()) return c.json({ error: 'Say something first' }, 400)
  return c.json(view(await engine.createDraft(text.trim().slice(0, 1000), source ?? 'text')))
})

app.get('/api/drafts', c => c.json(db.drafts.slice(0, 50).map(view)))
app.get('/api/drafts/:id', c => c.json(view(engine.getDraft(c.req.param('id')))))
app.post('/api/drafts/:id/pick', async c => {
  const { contactId, actionId } = await c.req.json<{ contactId: string; actionId?: string }>()
  return c.json(view(await engine.pick(c.req.param('id'), contactId, actionId)))
})
app.post('/api/drafts/:id/toggle', async c => {
  const { actionId, approved } = await c.req.json<{ actionId: string; approved?: boolean }>()
  return c.json(view(engine.toggle(c.req.param('id'), actionId, approved)))
})
app.post('/api/drafts/:id/edit', async c => {
  const { actionId, text } = await c.req.json<{ actionId: string; text: string }>()
  return c.json(view(engine.editAction(c.req.param('id'), actionId, text)))
})
app.post('/api/drafts/:id/approve', async c => c.json(view(await engine.approve(c.req.param('id')))))
app.post('/api/drafts/:id/discard', c => c.json(view(engine.discard(c.req.param('id')))))
app.post('/api/drafts/:id/undo', async c => {
  const body = await c.req.json<{ actionId?: string }>().catch(() => ({}) as { actionId?: string })
  const d = body.actionId ? await engine.undo(c.req.param('id'), body.actionId) : await engine.undoAll(c.req.param('id'))
  return c.json(view(d))
})

app.get('/api/contacts/search', async c => c.json(await engine.searchContacts(c.req.query('q') ?? '')))
app.get('/api/today', c => {
  const t = engine.today()
  return c.json({ ...t, drafts: t.drafts.map(view) })
})
app.get('/api/next', c => c.json(engine.nextMeeting()))
app.get('/api/before/:contactId', c => c.json(engine.before(c.req.param('contactId'))))
app.get('/api/outbox', c => c.json(db.outbox.slice(0, 50)))

// ── Telegram login (typed by the user on their own setup page) ──
const tgOrFail = () => {
  const tg = engine.getTelegram()
  if (!tg) throw new engine.HttpError(400, 'Set TG_API_ID and TG_API_HASH in server/.env first')
  return tg
}
app.post('/api/tg/start', async c => c.json(await tgOrFail().startLogin((await c.req.json<{ phone: string }>()).phone)))
app.post('/api/tg/code', async c => c.json({ result: await tgOrFail().submitCode((await c.req.json<{ code: string }>()).code) }))
app.post('/api/tg/password', async c => {
  await tgOrFail().submitPassword((await c.req.json<{ password: string }>()).password)
  return c.json({ result: 'ok' })
})
app.post('/api/tg/logout', async c => {
  await tgOrFail().logout()
  return c.json({ ok: true })
})

// ── Google Calendar sign-in on a separate page ──
app.get('/auth/google/start', c => {
  if (!calendar.configured()) return c.text('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server/.env first', 400)
  return c.redirect(calendar.authUrl())
})
app.get('/auth/google/callback', async c => {
  try {
    await calendar.handleCallback(c.req.query('code') ?? '', c.req.query('state') ?? '')
    return c.html('<meta name=viewport content="width=device-width"><body style="font:18px system-ui;background:#111;color:#3CFA44;padding:24px">Google Calendar connected. You can close this tab.</body>')
  } catch (e) {
    return c.text(`Google sign-in failed: ${(e as Error).message}`, 400)
  }
})
app.post('/api/google/disconnect', c => {
  calendar.disconnect()
  return c.json({ ok: true })
})

// ── Ginn Lite: anyone can try it with no login. Nothing is sent for them; they press send themselves. ──
const liteHits = new Map<string, number[]>()
function liteLimit(key: string) {
  const now = Date.now()
  const hits = (liteHits.get(key) ?? []).filter(t => now - t < 3600_000)
  if (hits.length >= 30) throw new engine.HttpError(429, 'Slow down: 30 debriefs per hour')
  hits.push(now)
  liteHits.set(key, hits)
}

function ics(title: string, startUtc: string, desc: string) {
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const s = new Date(startUtc)
  const e = new Date(s.getTime() + 30 * 60_000)
  const esc = (t: string) => t.replace(/[\\,;]/g, m => `\\${m}`).replace(/\n/g, '\\n')
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ginn//EN', 'BEGIN:VEVENT', `UID:${crypto.randomUUID()}@ginn`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(s)}`, `DTEND:${f(e)}`, `SUMMARY:${esc(title)}`, `DESCRIPTION:${esc(desc)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
}

app.post('/api/lite/debrief', async c => {
  const anon = (c.req.header('x-ginn-anon') ?? 'anon').slice(0, 40)
  liteLimit(anon + (c.req.header('cf-connecting-ip') ?? ''))
  const q = c.req.query()
  let text: string
  if ((c.req.header('content-type') ?? '').includes('json')) text = (await c.req.json<{ text: string }>()).text ?? ''
  else text = await transcribeAny(Buffer.from(await c.req.arrayBuffer()), (q.ext ?? 'webm').replace(/[^a-z0-9]/g, ''))
  text = text.trim().slice(0, 1000)
  if (!text) return c.json({ error: "Didn't catch that" }, 422)
  const s: Settings = {
    ...db.settings,
    myName: (q.name ?? '').slice(0, 40) || 'me',
    myCompany: (q.company ?? '').slice(0, 40) || 'my company',
    defaultEvent: (q.event ?? '').slice(0, 60) || 'the event',
    timezone: q.tz && DateTime.local().setZone(q.tz).isValid ? q.tz : db.settings.timezone,
    snippets: {},
  }
  const p = await parseDebrief(text, s)
  const u = (db.lite[anon] ??= { debriefs: 0, shares: 0, first: new Date().toISOString(), last: '' })
  u.debriefs++
  u.last = new Date().toISOString()
  save()
  return c.json({
    transcript: text,
    person: p.personName,
    company: p.company,
    actions: p.actions.map(a => {
      const at = a.when ? DateTime.fromISO(a.when, { zone: s.timezone }).toUTC().toISO() : null
      return {
        kind: a.kind,
        text: a.text,
        otherName: a.otherName,
        when: a.when ? DateTime.fromISO(a.when).toFormat('ccc d LLL, HH:mm') : 'now',
        share: a.kind === 'dm' || a.kind === 'intro' ? `https://t.me/share/url?url=${encodeURIComponent(' ')}&text=${encodeURIComponent(a.text)}` : undefined,
        ics: a.kind === 'meeting' && at ? `data:text/calendar;charset=utf-8,${encodeURIComponent(ics(a.text, at, text))}` : undefined,
      }
    }),
  })
})

app.post('/api/lite/share', async c => {
  const anon = (c.req.header('x-ginn-anon') ?? 'anon').slice(0, 40)
  if (db.lite[anon]) db.lite[anon].shares++
  save()
  return c.json({ ok: true })
})

app.get('/api/lite/stats', c => {
  const users = Object.values(db.lite)
  return c.json({ users: users.length, repeatUsers: users.filter(u => u.debriefs > 1).length, debriefs: users.reduce((n, u) => n + u.debriefs, 0), shares: users.reduce((n, u) => n + u.shares, 0) })
})

// ── pages ──
const page = (f: string) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8')
app.get('/', c => c.html(page('index.html')))
app.get('/lite', c => c.html(page('lite.html')))

await engine.initChannel()
serve({ fetch: app.fetch, port: config.port, hostname: config.host }, info => {
  console.log(`\n  Ginn server on http://localhost:${info.port}`)
  console.log(`  Parser: ${config.anthropicKey ? `Claude (${config.model})` : 'rules (offline) - set ANTHROPIC_API_KEY for Claude'}`)
  console.log(`  Pairing code: ${pairingCode}\n`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    saveNow()
    process.exit(0)
  })
