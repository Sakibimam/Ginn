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

const defaultSettings: Settings = {
  myName: process.env.GINN_MY_NAME ?? 'Sakib',
  myCompany: process.env.GINN_MY_COMPANY ?? 'RocketX',
  timezone: process.env.GINN_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  defaultEvent: process.env.GINN_EVENT ?? 'the event',
  dmTiming: 'now',
  autoSelf: true,
  snippets: {},
}

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

let timer: NodeJS.Timeout | null = null
export function save() {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 2))
    fs.renameSync(FILE + '.tmp', FILE)
  }, 50)
}

export function saveNow() {
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2))
}
