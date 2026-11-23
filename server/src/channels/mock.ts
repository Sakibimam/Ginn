// A fake Telegram so the whole flow runs with no account. Sends land in db.outbox.
import { db, save } from '../store.js'
import type { Contact } from '../types.js'
import type { Channel, SendResult } from './types.js'

const people: [string, string?][] = [
  ['Alex Chen | Hyperliquid', 'alexhl'],
  ['Alex Rivera', 'arivera'],
  ['Omar Haddad', 'omar_vc'],
  ['Priya Nair', 'priya_polygon'],
  ['Sara Kim', 'sarak'],
  ['Daniel Okafor', 'dokafor'],
  ['Mei Lin | TON', 'meilin'],
  ['Rahul Verma', 'rahulv'],
  ['Fatima Al Mansoori', 'fatima_daos'],
  ['Jonas Weber', 'jonasw'],
  ['Lucas Ferreira', 'lucasf'],
  ['Aisha Khan', 'aishak'],
]
const CONTACTS: Contact[] = people.map(([name, username], i) => ({ id: `m${i + 1}`, name, username, source: 'mock' }))

const timers = new Map<string, NodeJS.Timeout>()
let seq = 0

function deliver(id: string, to: string, text: string, kind: string, at: Date) {
  const run = () => {
    timers.delete(id)
    db.outbox.unshift({ at: new Date().toISOString(), to, text, kind })
    db.outbox = db.outbox.slice(0, 200)
    save()
  }
  const wait = at.getTime() - Date.now()
  if (wait <= 0) run()
  else timers.set(id, setTimeout(run, Math.min(wait, 2 ** 31 - 1)))
}

export class MockChannel implements Channel {
  readonly name = 'mock' as const
  connected() {
    return true
  }
  async me() {
    return 'Demo account (mock Telegram)'
  }
  async contacts() {
    return CONTACTS
  }
  async send(to: Contact | 'self', text: string, at: Date): Promise<SendResult> {
    const id = `mock-${++seq}`
    const dest = to === 'self' ? 'Saved Messages' : to.name
    deliver(id, dest, text, to === 'self' ? 'reminder' : 'dm', at)
    return { detail: `to ${dest}`, refs: { id } }
  }
  async createGroup(title: string, members: Contact[], intro: string): Promise<SendResult> {
    db.outbox.unshift({ at: new Date().toISOString(), to: `group "${title}" (${members.map(m => m.name).join(', ')})`, text: intro, kind: 'intro' })
    save()
    return { detail: `group "${title}"`, link: 'https://t.me/+mockinvite', refs: {} }
  }
  async undo(refs: Record<string, unknown>) {
    const t = timers.get(String(refs.id))
    if (!t) return false
    clearTimeout(t)
    timers.delete(String(refs.id))
    return true
  }
}
