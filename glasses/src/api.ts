// Talks to the user's own Ginn server. No API keys live in the app: only the server URL and a pairing token.

export interface Contact {
  id: string
  name: string
  username?: string
}
export interface Action {
  id: string
  kind: 'dm' | 'intro' | 'meeting' | 'reminder'
  text: string
  otherName?: string | null
  other?: Contact | null
  otherCandidates?: { contact: Contact; score: number }[]
  at: string | null
  when: string
  approved: boolean
  status: 'pending' | 'queued' | 'sent' | 'failed' | 'skipped' | 'undone'
  detail?: string
  link?: string
  error?: string
}
export interface Draft {
  id: string
  transcript: string
  parser: string
  person: { spokenName: string; company: string | null }
  contact: Contact | null
  candidates: { contact: Contact; score: number }[]
  actions: Action[]
  status: 'needs_pick' | 'ready' | 'done' | 'discarded'
}
export interface Today {
  met: number
  sent: number
  ghosted: number
  drafts: Draft[]
}

const KEY_URL = 'ginn.server'
const KEY_TOKEN = 'ginn.token'
const DEFAULT_URL = (import.meta.env.VITE_GINN_SERVER as string | undefined) ?? 'http://localhost:8787'

export const conn = {
  url: localStorage.getItem(KEY_URL) || DEFAULT_URL,
  token: localStorage.getItem(KEY_TOKEN) || '',
}

export function setServer(url: string, token?: string) {
  conn.url = url.replace(/\/+$/, '')
  localStorage.setItem(KEY_URL, conn.url)
  if (token !== undefined) {
    conn.token = token
    localStorage.setItem(KEY_TOKEN, token)
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Every request has a deadline, so the lens never hangs on "working". Audio gets longer for transcription. */
async function call<T>(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  if (conn.token) headers.authorization = `Bearer ${conn.token}`
  if (init.body && typeof init.body === 'string') headers['content-type'] = 'application/json'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(conn.url + path, { ...init, headers, signal: ctrl.signal })
  } catch (e) {
    throw new ApiError(0, (e as Error).name === 'AbortError' ? 'Your Ginn server is taking too long' : "Can't reach your Ginn server")
  } finally {
    clearTimeout(timer)
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Server error ${res.status}`)
  return data
}

const post = <T>(path: string, body?: unknown) => call<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

export const api = {
  health: () => call<Health>('/api/health', {}, 6000),
  pair: async (url: string, code: string) => {
    setServer(url, '')
    const r = await post<{ token: string }>('/api/pair', { code })
    setServer(url, r.token)
  },
  debriefPcm: (pcm: Uint8Array) =>
    call<Draft>('/api/debrief/pcm', { method: 'POST', body: pcm as unknown as BodyInit, headers: { 'content-type': 'application/octet-stream' } }, 90_000),
  approve: (id: string) => call<Draft>(`/api/drafts/${id}/approve`, { method: 'POST', body: '{}' }, 45_000),
  debriefText: (text: string, source: 'glasses' | 'phone' | 'text' = 'text') => post<Draft>('/api/debrief/text', { text, source }),
  draft: (id: string) => call<Draft>(`/api/drafts/${id}`),
  pick: (id: string, contactId: string, actionId?: string) => post<Draft>(`/api/drafts/${id}/pick`, { contactId, actionId }),
  toggle: (id: string, actionId: string, approved?: boolean) => post<Draft>(`/api/drafts/${id}/toggle`, { actionId, approved }),
  edit: (id: string, actionId: string, text: string) => post<Draft>(`/api/drafts/${id}/edit`, { actionId, text }),
  discard: (id: string) => post<Draft>(`/api/drafts/${id}/discard`),
  undo: (id: string, actionId?: string) => post<Draft>(`/api/drafts/${id}/undo`, { actionId }),
  today: () => call<Today>('/api/today'),
  next: () => call<NextCard | null>('/api/next'),
}

export interface Health {
  ok: boolean
  parser: string
  telegram: { connected: boolean; mock: boolean; me?: string | null }
  calendar: { connected: boolean; configured: boolean }
  undoSeconds: number
  maxListenSeconds: number
  setupNeeded: boolean
  paired: boolean
}

export interface NextCard {
  title: string
  when: string
  contact: Contact
  lastMet: string
  sent: string[]
  open: string[]
}
