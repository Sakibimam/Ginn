// Real Telegram, as the user, through MTProto (GramJS). Runs on the user's own server, never in the app.
// The session is encrypted at rest. Contacts and messages stay here and are never sent to an AI.
import fs from 'node:fs'
import path from 'node:path'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import bigInt from 'big-integer'
import { config, DATA_DIR, encrypt, decrypt } from '../config.js'
import type { Contact } from '../types.js'
import type { Channel, SendResult } from './types.js'

const SESSION_FILE = path.join(DATA_DIR, 'tg.session.enc')

function readSession(): string {
  try {
    return decrypt(fs.readFileSync(SESSION_FILE, 'utf8'))
  } catch {
    return ''
  }
}

export class TelegramChannel implements Channel {
  readonly name = 'telegram' as const
  private client: TelegramClient
  private authed = false
  private users = new Map<string, Api.User>()
  private cache: { at: number; list: Contact[] } | null = null
  private login: { phone: string; hash: string } | null = null

  constructor() {
    this.client = new TelegramClient(new StringSession(readSession()), config.tgApiId, config.tgApiHash, {
      connectionRetries: 5,
      deviceModel: 'Ginn server',
      appVersion: '0.1.0',
    })
    this.client.setLogLevel('error' as never)
  }

  async init() {
    await this.client.connect()
    this.authed = await this.client.checkAuthorization()
    return this.authed
  }

  connected() {
    return this.authed
  }

  private persist() {
    const s = (this.client.session as StringSession).save()
    fs.writeFileSync(SESSION_FILE, encrypt(s), { mode: 0o600 })
  }

  // ── login: phone → code → (2FA password). The user types these on their own phone page. ──
  async startLogin(phone: string) {
    const r = await this.client.sendCode({ apiId: config.tgApiId, apiHash: config.tgApiHash }, phone)
    this.login = { phone, hash: r.phoneCodeHash }
    return { viaApp: r.isCodeViaApp }
  }

  async submitCode(code: string): Promise<'ok' | 'password'> {
    if (!this.login) throw new Error('Start login first')
    try {
      await this.client.invoke(
        new Api.auth.SignIn({ phoneNumber: this.login.phone, phoneCodeHash: this.login.hash, phoneCode: code }),
      )
    } catch (e) {
      if ((e as { errorMessage?: string }).errorMessage === 'SESSION_PASSWORD_NEEDED') return 'password'
      throw e
    }
    this.finishLogin()
    return 'ok'
  }

  async submitPassword(password: string) {
    let failure: Error | null = null
    await this.client.signInWithPassword(
      { apiId: config.tgApiId, apiHash: config.tgApiHash },
      { password: async () => password, onError: async err => { failure = err; return true } },
    )
    if (failure) throw failure
    this.finishLogin()
  }

  private finishLogin() {
    this.authed = true
    this.login = null
    this.cache = null
    this.persist()
  }

  async logout() {
    try {
      await this.client.invoke(new Api.auth.LogOut())
    } finally {
      this.authed = false
      fs.rmSync(SESSION_FILE, { force: true })
    }
  }

  async me() {
    if (!this.authed) return null
    const u = (await this.client.getMe()) as Api.User
    return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || 'You'
  }

  /** Contacts + people you've chatted with recently. Cached 10 minutes. */
  async contacts(): Promise<Contact[]> {
    if (!this.authed) return []
    if (this.cache && Date.now() - this.cache.at < 10 * 60_000) return this.cache.list
    const seen = new Map<string, Contact>()
    const add = (u: Api.User) => {
      if (u.bot || u.self || u.deleted) return
      const id = u.id.toString()
      this.users.set(id, u)
      const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.username || id
      seen.set(id, { id, name, username: u.username ?? undefined, source: 'telegram' })
    }
    const res = await this.client.invoke(new Api.contacts.GetContacts({ hash: bigInt(0) }))
    if (res instanceof Api.contacts.Contacts) for (const u of res.users) if (u instanceof Api.User) add(u)
    for (const d of await this.client.getDialogs({ limit: 150 })) if (d.entity instanceof Api.User) add(d.entity)
    const list = [...seen.values()]
    this.cache = { at: Date.now(), list }
    return list
  }

  private async peer(c: Contact) {
    const u = this.users.get(c.id)
    if (u) return u
    return this.client.getInputEntity(c.username ? `@${c.username}` : bigInt(c.id))
  }

  async send(to: Contact | 'self', text: string, at: Date): Promise<SendResult> {
    const entity = to === 'self' ? 'me' : await this.peer(to)
    const future = at.getTime() - Date.now() > 5_000
    const msg = await this.client.sendMessage(entity, { message: text, schedule: future ? Math.floor(at.getTime() / 1000) : undefined })
    return {
      detail: to === 'self' ? 'to Saved Messages' : `to ${to.name}`,
      refs: { peer: to === 'self' ? 'me' : to.id, username: to === 'self' ? undefined : to.username, msgId: msg.id, scheduled: future },
    }
  }

  async createGroup(title: string, members: Contact[], intro: string): Promise<SendResult> {
    const users = await Promise.all(members.map(m => this.peer(m)))
    const res = (await this.client.invoke(new Api.messages.CreateChat({ users, title }))) as unknown as {
      updates: Api.TypeUpdates
      missingInvitees?: Api.MissingInvitee[]
    }
    const updates = res.updates as Api.Updates
    const chat = updates.chats?.[0]
    if (!chat) throw new Error('Telegram did not return the new group')
    await this.client.sendMessage(chat, { message: intro })

    const missing = (res.missingInvitees ?? []).map(m => m.userId.toString())
    let link: string | undefined
    let detail = `group "${title}"`
    if (missing.length) {
      const inv = (await this.client.invoke(new Api.messages.ExportChatInvite({ peer: chat }))) as Api.ChatInviteExported
      link = inv.link
      for (const id of missing) {
        const m = members.find(x => x.id === id)
        if (m) await this.client.sendMessage(await this.peer(m), { message: `${intro}\n\nJoin the group here: ${link}` })
      }
      detail += ` (invite link sent to ${missing.length} who block group adds)`
    }
    return { detail, link, refs: { chatId: chat.id.toString() } }
  }

  async undo(refs: Record<string, unknown>) {
    if (!refs.scheduled || !refs.msgId) return false
    const peer = refs.peer === 'me' ? 'me' : refs.username ? `@${refs.username}` : bigInt(String(refs.peer))
    const users = this.users.get(String(refs.peer))
    await this.client.invoke(
      new Api.messages.DeleteScheduledMessages({ peer: users ?? (await this.client.getInputEntity(peer)), id: [Number(refs.msgId)] }),
    )
    return true
  }
}
