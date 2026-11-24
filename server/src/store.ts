import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.js'
import type { Draft, Settings } from './types.js'

interface Db {
  settings: Settings
  drafts: Draft[]
  /** Anonymous Ginn Lite usage: anon id -> count. No transcripts are stored for Lite users. */
  lite: Record<string, { debriefs: number; shares: number; first: string; last: string }>
  /** Mock-mode outbox, so you can see what would have been sent. */
  outbox: { at: string; to: string; text: string; kind: string }[]
}

const FILE = path.join(DATA_DIR, 'db.json')

export const defaultSettings: Settings = {
  myName: process.env.GINN_MY_NAME ?? '',
  myCompany: process.env.GINN_MY_COMPANY ?? '',
  timezone: process.env.GINN_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  defaultEvent: process.env.GINN_EVENT ?? '',
  dmTiming: 'now',
  autoSelf: true,
  snippets: {},
  meetingHour: 11,
  meetingMinutes: 30,
  reminderLeadMinutes: 15,
  groupTitle: '{me} <> {them}',
}

const MAX_DRAFTS = 2000
const MAX_OUTBOX = 200

function load(): Db {
  try {
    const db = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Db
    db.settings = { ...defaultSettings, ...db.settings }
    db.lite ??= {}
    db.outbox ??= []
    return db
  } catch {
    return { settings: defaultSettings, drafts: [], lite: {}, outbox: [] }
  }
}

export const db: Db = load()

function write() {
  if (db.drafts.length > MAX_DRAFTS) db.drafts.length = MAX_DRAFTS
  if (db.outbox.length > MAX_OUTBOX) db.outbox.length = MAX_OUTBOX
  // Transcripts and contact names live here: owner-only permissions, atomic replace.
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 2), { mode: 0o600 })
  fs.renameSync(FILE + '.tmp', FILE)
  fs.chmodSync(FILE, 0o600)
}

// Tighten anything created before permissions were enforced.
try {
  fs.chmodSync(DATA_DIR, 0o700)
  for (const f of fs.readdirSync(DATA_DIR)) fs.chmodSync(path.join(DATA_DIR, f), 0o600)
} catch {
  /* best effort */
}

let timer: NodeJS.Timeout | null = null
export function save() {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    try {
      write()
    } catch (e) {
      console.error('[store] save failed:', (e as Error).message)
    }
  }, 50)
}

export function saveNow() {
  if (timer) clearTimeout(timer)
  timer = null
  write()
}
