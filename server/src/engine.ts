import crypto from 'node:crypto'
import { DateTime } from 'luxon'
import { config } from './config.js'
import { db, save } from './store.js'
import { parseDebrief } from './parse.js'
import { matchContact } from './match.js'
import { calendar } from './calendar.js'
import { MockChannel } from './channels/mock.js'
import { TelegramChannel } from './channels/telegram.js'
import type { Channel } from './channels/types.js'
import type { Contact, Draft, PlannedAction } from './types.js'

const id = () => crypto.randomBytes(5).toString('hex')

let channel: Channel = new MockChannel()
let telegram: TelegramChannel | null = null

export async function initChannel() {
  if (!config.tgApiId || !config.tgApiHash) {
    console.log('[telegram] TG_API_ID/TG_API_HASH not set: using mock Telegram')
    return
  }
  telegram = new TelegramChannel()
  channel = telegram
  try {
    const ok = await telegram.init()
    console.log(ok ? `[telegram] logged in as ${await telegram.me()}` : '[telegram] not logged in yet: open the setup page')
  } catch (e) {
    console.error('[telegram] connect failed:', (e as Error).message)
  }
}

export const getChannel = () => channel
export const getTelegram = () => telegram

// ── time helpers ──
const tz = () => db.settings.timezone

function localToUtc(local: string | null): string | null {
  if (!local) return null
  const dt = DateTime.fromISO(local, { zone: tz() })
  return dt.isValid ? dt.toUTC().toISO() : null
}

export function whenLabel(at: string | null): string {
  if (!at) return 'now'
  const d = DateTime.fromISO(at).setZone(tz())
  const now = DateTime.now().setZone(tz())
  const day = d.hasSame(now, 'day') ? 'today' : d.hasSame(now.plus({ days: 1 }), 'day') ? 'tmrw' : d.toFormat('ccc d LLL')
  return `${day} ${d.toFormat('HH:mm')}`
}

function morning(): string {
  return DateTime.now().setZone(tz()).plus({ days: 1 }).set({ hour: 10, minute: 0, second: 0 }).toUTC().toISO()!
}

// ── drafts ──
export async function createDraft(transcript: string, source: Draft['source']): Promise<Draft> {
  const s = db.settings
  const parsed = await parseDebrief(transcript, s)
  const contacts = await channel.contacts()
  const m = matchContact(parsed.personName, parsed.company, contacts)

  const actions: PlannedAction[] = parsed.actions.map(a => {
    const act: PlannedAction = {
      id: id(),
      kind: a.kind,
      text: a.text,
      otherName: a.otherName,
      at: localToUtc(a.when),
      approved: true,
      status: 'pending',
    }
    if (a.kind === 'dm' && !act.at && s.dmTiming === 'morning') act.at = morning()
    if (a.kind === 'intro' && a.otherName) {
      const o = matchContact(a.otherName, null, contacts)
      act.other = o.contact
      act.otherCandidates = o.candidates
    }
    return act
  })

  const draft: Draft = {
    id: id(),
    createdAt: new Date().toISOString(),
    source,
    transcript,
    parser: parsed.parser,
    person: { spokenName: parsed.personName, company: parsed.company },
    event: parsed.event,
    contact: m.contact,
    candidates: m.candidates,
    actions,
    status: m.contact ? 'ready' : 'needs_pick',
  }
  db.drafts.unshift(draft)
  save()
  return draft
}

export function getDraft(draftId: string) {
  const d = db.drafts.find(x => x.id === draftId)
  if (!d) throw new HttpError(404, 'Draft not found')
  return d
}

export async function pick(draftId: string, contactId: string, actionId?: string) {
  const d = getDraft(draftId)
  const contacts = await channel.contacts()
  const c = contacts.find(x => x.id === contactId) ?? [...d.candidates, ...d.actions.flatMap(a => a.otherCandidates ?? [])].map(x => x.contact).find(x => x.id === contactId)
  if (!c) throw new HttpError(400, 'Unknown contact')
  if (actionId) {
    const a = d.actions.find(x => x.id === actionId)
    if (!a) throw new HttpError(404, 'Action not found')
    a.other = c
  } else {
    d.contact = c
    if (d.status === 'needs_pick') d.status = 'ready'
  }
  save()
  return d
}

export async function searchContacts(q: string) {
  const contacts = await channel.contacts()
  return matchContact(q, null, contacts).candidates.length
    ? matchContact(q, null, contacts).candidates.map(c => c.contact)
    : contacts.filter(c => c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 5)
}

export function toggle(draftId: string, actionId: string, approved?: boolean) {
  const d = getDraft(draftId)
  const a = d.actions.find(x => x.id === actionId)
  if (!a) throw new HttpError(404, 'Action not found')
  a.approved = approved ?? !a.approved
  save()
  return d
}

export function editAction(draftId: string, actionId: string, text: string) {
  const d = getDraft(draftId)
  const a = d.actions.find(x => x.id === actionId)
  if (!a || a.status !== 'pending') throw new HttpError(400, 'Cannot edit this action')
  a.text = text.slice(0, 1000)
  save()
  return d
}

export function discard(draftId: string) {
  const d = getDraft(draftId)
  d.status = 'discarded'
  save()
  return d
}

const delayed = new Map<string, NodeJS.Timeout>()

/** Runs every approved action. Messages wait `undoSeconds` in Telegram's scheduled queue so you can undo. */
export async function approve(draftId: string) {
  const d = getDraft(draftId)
  if (d.status === 'done') return d
  if (!d.contact && d.actions.some(a => a.approved && (a.kind === 'dm' || a.kind === 'intro')))
    throw new HttpError(409, 'Pick who you met first')
  const undoAt = () => new Date(Date.now() + config.undoSeconds * 1000)

  for (const a of d.actions) {
    if (a.status !== 'pending') continue
    if (!a.approved) {
      a.status = 'skipped'
      continue
    }
    try {
      if (a.kind === 'dm') {
        const at = a.at && new Date(a.at) > undoAt() ? new Date(a.at) : undoAt()
        const r = await channel.send(d.contact!, a.text, at)
        Object.assign(a, { status: 'queued', at: at.toISOString(), detail: r.detail, refs: r.refs })
      } else if (a.kind === 'reminder') {
        const at = a.at && new Date(a.at) > undoAt() ? new Date(a.at) : undoAt()
        const r = await channel.send('self', `Ginn reminder: ${a.text}`, at)
        Object.assign(a, { status: 'queued', at: at.toISOString(), detail: r.detail, refs: r.refs })
      } else if (a.kind === 'intro') {
        if (!a.other) throw new Error(`Couldn't find ${a.otherName ?? 'the other person'} in your contacts`)
        // Groups can't be scheduled, so hold them on the server for the undo window.
        a.status = 'queued'
        a.detail = 'creating group…'
        const contact = d.contact!
        const other = a.other
        const title = `${db.settings.myCompany} <> ${d.person.company ?? contact.name.split(/[ |]/)[0]}`
        delayed.set(
          a.id,
          setTimeout(async () => {
            delayed.delete(a.id)
            try {
              const r = await channel.createGroup(title, [contact, other], a.text)
              Object.assign(a, { status: 'sent', detail: r.detail, link: r.link, refs: r.refs })
            } catch (e) {
              Object.assign(a, { status: 'failed', error: (e as Error).message })
            }
            save()
          }, config.undoSeconds * 1000),
        )
        a.at = undoAt().toISOString()
      } else if (a.kind === 'meeting') {
        const start = a.at ? new Date(a.at) : new Date(morning())
        const desc = `Promised in person. Debrief: "${d.transcript}"`
        if (calendar.connected()) {
          const ev = await calendar.createEvent(a.text, start, 30, db.settings.timezone, desc)
          Object.assign(a, { status: 'sent', detail: 'Google Calendar', link: ev.link, refs: { eventId: ev.id } })
        } else {
          // No calendar connected: a Telegram reminder 15 minutes before.
          const at = new Date(Math.max(start.getTime() - 15 * 60_000, undoAt().getTime()))
          const r = await channel.send('self', `Ginn: ${a.text} at ${whenLabel(start.toISOString())}`, at)
          Object.assign(a, { status: 'queued', detail: 'reminder in Saved Messages (connect Google Calendar for events)', refs: r.refs })
        }
      }
    } catch (e) {
      Object.assign(a, { status: 'failed', error: (e as Error).message })
    }
  }
  d.status = 'done'
  save()
  return d
}

export async function undo(draftId: string, actionId: string) {
  const d = getDraft(draftId)
  const a = d.actions.find(x => x.id === actionId)
  if (!a) throw new HttpError(404, 'Action not found')
  const t = delayed.get(a.id)
  if (t) {
    clearTimeout(t)
    delayed.delete(a.id)
  } else if (a.refs?.eventId) {
    await calendar.deleteEvent(String(a.refs.eventId))
  } else if (!(a.refs && (await channel.undo(a.refs)))) {
    throw new HttpError(409, 'Already sent')
  }
  a.status = 'undone'
  save()
  return d
}

/** Undo everything still waiting in a draft. */
export async function undoAll(draftId: string) {
  const d = getDraft(draftId)
  for (const a of d.actions) if (a.status === 'queued') await undo(draftId, a.id).catch(() => undefined)
  return d
}

/** Queued Telegram messages count as sent once their time passes. */
export function refresh(d: Draft) {
  for (const a of d.actions) if (a.status === 'queued' && a.at && new Date(a.at) <= new Date() && !delayed.has(a.id)) a.status = 'sent'
  return d
}

export function today() {
  const start = DateTime.now().setZone(tz()).startOf('day')
  const drafts = db.drafts.filter(d => DateTime.fromISO(d.createdAt) >= start && d.status !== 'discarded').map(refresh)
  const sent = drafts.flatMap(d => d.actions).filter(a => a.status === 'sent' || a.status === 'queued').length
  const open = drafts.filter(d => d.status === 'ready' || d.status === 'needs_pick')
  return { met: drafts.length, sent, ghosted: open.length, open: open.map(d => d.id), drafts }
}

/** "Before you meet X": your own promise log with that person. No Telegram data. */
export function before(contactId: string) {
  const past = db.drafts.filter(d => d.contact?.id === contactId && d.status === 'done').map(refresh)
  if (!past.length) return null
  const last = past[0]
  const sent = past.flatMap(d => d.actions).filter(a => a.status === 'sent' && a.kind !== 'meeting')
  const upcoming = past.flatMap(d => d.actions).filter(a => a.kind === 'meeting' && a.at && new Date(a.at) > new Date())
  return {
    contact: last.contact as Contact,
    lastMet: whenLabel(last.createdAt),
    company: last.person.company,
    sent: sent.map(a => `${a.kind === 'intro' ? 'Intro' : 'Sent'}: ${a.text.slice(0, 60)}`),
    upcoming: upcoming.map(a => `${a.text} · ${whenLabel(a.at)}`),
  }
}

/** The next meeting you promised, with what you already delivered to that person. */
export function nextMeeting() {
  const now = new Date()
  const upcoming = db.drafts
    .filter(d => d.status === 'done' && d.contact)
    .flatMap(d => d.actions.filter(a => a.kind === 'meeting' && a.at && new Date(a.at) > now && a.status !== 'undone' && a.status !== 'skipped').map(a => ({ d, a })))
    .sort((x, y) => new Date(x.a.at!).getTime() - new Date(y.a.at!).getTime())
  const hit = upcoming[0]
  if (!hit) return null
  const mine = db.drafts.filter(d => d.contact?.id === hit.d.contact!.id && d.status === 'done').map(refresh)
  const acts = mine.flatMap(d => d.actions)
  return {
    title: hit.a.text,
    when: whenLabel(hit.a.at),
    contact: hit.d.contact!,
    lastMet: whenLabel(mine[0].createdAt),
    sent: acts.filter(a => a.status === 'sent' && a.kind === 'dm').map(a => `DM: ${a.text.slice(0, 50)}`).concat(acts.filter(a => a.status === 'sent' && a.kind === 'intro').map(a => `Intro to ${a.other?.name ?? a.otherName}`)),
    open: acts.filter(a => a.status === 'failed' || a.status === 'pending').map(a => `${a.kind}: ${a.text.slice(0, 50)}`),
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
