// Google Calendar through OAuth on a separate page (Google sign-in does not work inside the G2 WebView).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config, DATA_DIR, encrypt, decrypt } from './config.js'

const TOKEN_FILE = path.join(DATA_DIR, 'google.tokens.enc')
const SCOPE = 'https://www.googleapis.com/auth/calendar.events'
const redirectUri = () => `${config.publicUrl}/auth/google/callback`

interface Tokens {
  access_token: string
  refresh_token?: string
  expires_at: number
}

let tokens: Tokens | null = (() => {
  try {
    return JSON.parse(decrypt(fs.readFileSync(TOKEN_FILE, 'utf8'))) as Tokens
  } catch {
    return null
  }
})()

const states = new Set<string>()

export const calendar = {
  configured: () => Boolean(config.googleClientId && config.googleClientSecret),
  connected: () => Boolean(tokens),

  authUrl(): string {
    const state = crypto.randomBytes(12).toString('hex')
    states.add(state)
    const q = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state,
    })
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`
  },

  async handleCallback(code: string, state: string) {
    if (!states.delete(state)) throw new Error('Login expired, start again')
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
      }),
    })
    const j = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string }
    if (!j.access_token) throw new Error(j.error ?? 'Google login failed')
    save({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in ?? 3600) * 1000 })
  },

  disconnect() {
    tokens = null
    fs.rmSync(TOKEN_FILE, { force: true })
  },

  /** Creates an event; returns its link. */
  async createEvent(title: string, start: Date, minutes: number, timezone: string, description: string) {
    const token = await accessToken()
    const end = new Date(start.getTime() + minutes * 60_000)
    const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        summary: title,
        description,
        start: { dateTime: start.toISOString(), timeZone: timezone },
        end: { dateTime: end.toISOString(), timeZone: timezone },
        reminders: { useDefault: true },
      }),
    })
    const j = (await r.json()) as { id?: string; htmlLink?: string; error?: { message: string } }
    if (!j.id) throw new Error(j.error?.message ?? 'Calendar event failed')
    return { id: j.id, link: j.htmlLink }
  },

  async deleteEvent(id: string) {
    const token = await accessToken()
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
  },
}

function save(t: Tokens) {
  tokens = { ...t, refresh_token: t.refresh_token ?? tokens?.refresh_token }
  fs.writeFileSync(TOKEN_FILE, encrypt(JSON.stringify(tokens)), { mode: 0o600 })
}

async function accessToken(): Promise<string> {
  if (!tokens) throw new Error('Google Calendar not connected')
  if (Date.now() < tokens.expires_at - 60_000) return tokens.access_token
  if (!tokens.refresh_token) throw new Error('Google session expired, connect again')
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: tokens.refresh_token,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      grant_type: 'refresh_token',
    }),
  })
  const j = (await r.json()) as { access_token?: string; expires_in?: number; error?: string }
  if (!j.access_token) throw new Error(j.error ?? 'Google refresh failed')
  save({ access_token: j.access_token, expires_at: Date.now() + (j.expires_in ?? 3600) * 1000 })
  return tokens!.access_token
}
