import type { Contact } from '../types.js'

export interface SendResult {
  detail: string
  link?: string
  refs: Record<string, unknown>
}

/** One adapter per messaging platform. Telegram is first; Gmail/WhatsApp follow the same shape. */
export interface Channel {
  readonly name: 'telegram' | 'mock'
  connected(): boolean
  me(): Promise<string | null>
  contacts(): Promise<Contact[]>
  /** Sends (or schedules, when `at` is in the future) a message. `to: 'self'` = Saved Messages. */
  send(to: Contact | 'self', text: string, at: Date): Promise<SendResult>
  /** Creates a group with the members, posts the intro. Falls back to an invite link if privacy blocks an add. */
  createGroup(title: string, members: Contact[], intro: string): Promise<SendResult>
  /** Cancels something still in the scheduled queue. */
  undo(refs: Record<string, unknown>): Promise<boolean>
}
