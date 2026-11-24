export type ActionKind = 'dm' | 'intro' | 'meeting' | 'reminder'

export interface Contact {
  id: string
  name: string
  username?: string
  source: 'telegram' | 'mock'
}

export interface Candidate {
  contact: Contact
  score: number
}

export type ActionStatus = 'pending' | 'queued' | 'sent' | 'failed' | 'skipped' | 'undone'

export interface PlannedAction {
  id: string
  kind: ActionKind
  /** dm/intro: message text. meeting: event title. reminder: note to self. */
  text: string
  /** intro only: the second person, as spoken and as matched. */
  otherName?: string | null
  other?: Contact | null
  otherCandidates?: Candidate[]
  /** ISO time (UTC) the message is scheduled for or the event starts. null = as soon as approved. */
  at: string | null
  approved: boolean
  status: ActionStatus
  detail?: string
  link?: string
  error?: string
  /** channel references needed for undo (peer id, scheduled message ids...). */
  refs?: Record<string, unknown>
}

export interface Draft {
  id: string
  createdAt: string
  source: 'glasses' | 'phone' | 'text'
  transcript: string
  parser: 'claude' | 'rules'
  person: { spokenName: string; company: string | null }
  event: string | null
  contact: Contact | null
  candidates: Candidate[]
  actions: PlannedAction[]
  status: 'needs_pick' | 'ready' | 'done' | 'discarded'
}

export interface Settings {
  myName: string
  myCompany: string
  timezone: string
  /** Event name used in messages when the debrief doesn't name one. */
  defaultEvent: string
  /** 'now' = send after the undo window. 'morning' = next day at 10:00. */
  dmTiming: 'now' | 'morning'
  /** Auto-approve reminders to yourself and calendar holds (never messages to others). */
  autoSelf: boolean
  /** Phrases you often promise, with the link to send. e.g. "listing deck" -> https://... */
  snippets: Record<string, string>
  /** Hour used when you name a day but no time ("call Tuesday"). */
  meetingHour: number
  /** Length of calendar events Ginn creates. */
  meetingMinutes: number
  /** Without a calendar, the Telegram reminder fires this many minutes before. */
  reminderLeadMinutes: number
  /** Intro group name. {me} = your company, {them} = their company or first name. */
  groupTitle: string
}
