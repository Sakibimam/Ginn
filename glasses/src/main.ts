// Ginn on G2: tap after a conversation, say one line, approve, done.
import { waitForEvenAppBridge, OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { api, ApiError, type Draft, type Action } from './api'
import * as lens from './lens'
import { mountPhone, renderPhone } from './phone'

type Screen = 'home' | 'listening' | 'working' | 'pick' | 'review' | 'detail' | 'sent' | 'message' | 'next'

export const state = {
  screen: 'home' as Screen,
  draft: null as Draft | null,
  detail: null as Action | null,
  today: { met: 0, sent: 0, ghosted: 0 },
  error: '',
  log: [] as string[],
  serverOk: false,
}

// Defaults until the server tells us its own limits (GINN_UNDO_SECONDS, GINN_MAX_LISTEN_SECONDS).
const limits = { undo: 20, listen: 45 }
let bridge: EvenAppBridge
let pcm: Uint8Array[] = []
let listenStart = 0
let ticker: number | null = null
let busy = false
let sentAt = 0

const log = (m: string) => {
  state.log.unshift(`${new Date().toLocaleTimeString()}  ${m}`)
  state.log = state.log.slice(0, 30)
  console.log('[ginn]', m)
}

function stopTicker() {
  if (ticker !== null) {
    clearInterval(ticker)
    clearTimeout(ticker)
  }
  ticker = null
}

const first = (n?: string | null) => (n ?? '').split(/[\s|]+/)[0] || 'them'
const who = (d: Draft) => d.contact?.name ?? d.person.spokenName

function actionLine(a: Action, d: Draft) {
  const mark = a.kind === 'intro' && !a.other ? '[!]' : a.approved ? '[x]' : '[ ]'
  switch (a.kind) {
    case 'dm':
      return `${mark} DM ${a.when}: ${a.text}`
    case 'intro':
      return a.other ? `${mark} Intro ${first(who(d))} + ${a.other.name}` : `${mark} Intro: who is ${a.otherName}?`
    case 'meeting':
      return `${mark} ${a.text} · ${a.when}`
    case 'reminder':
      return `${mark} Remind me: ${a.text}`
  }
}

function doneLine(a: Action, d: Draft) {
  const s = a.status === 'failed' ? `FAILED: ${a.error ?? ''}` : a.status === 'skipped' ? 'skipped' : a.status === 'undone' ? 'undone' : ''
  switch (a.kind) {
    case 'dm':
      return `DM to ${first(who(d))} ${s || (a.status === 'sent' ? 'sent' : 'sending')}`
    case 'intro':
      return `Intro group + ${first(a.other?.name)} ${s || (a.status === 'sent' ? 'created' : 'creating')}`
    case 'meeting':
      return `${a.text} ${s || '· ' + a.when + (a.detail === 'Google Calendar' ? ' · Calendar' : '')}`
    case 'reminder':
      return `Reminder ${s || '· ' + a.when}`
  }
}

// ───────────────────────── screens ─────────────────────────

async function home() {
  stopTicker()
  state.screen = 'home'
  state.draft = null
  try {
    const [t, h] = await Promise.all([api.today(), api.health()])
    state.today = t
    limits.undo = h.undoSeconds ?? limits.undo
    limits.listen = h.maxListenSeconds ?? limits.listen
    state.serverOk = true
  } catch (e) {
    state.serverOk = false
    state.error = e instanceof ApiError && e.status === 401 ? 'not-paired' : (e as Error).message
  }
  const t = state.today
  const body = state.serverOk
    ? `GINN\nTap after a conversation.\nSay who, and what you promised.\n\nToday: ${t.met} met · ${t.sent} sent · ${t.ghosted} ghosted\n${t.ghosted ? 'Swipe up: ' + t.ghosted + ' waiting for you\n' : ''}Swipe down: your next meeting`
    : state.error === 'not-paired'
      ? `GINN\nNot paired yet.\nOpen Ginn in the Even app on your phone\nand enter the code from your server.\n\nTap to try again.`
      : `GINN\n${state.error || "Can't reach your Ginn server."}\nCheck the server is running, or pair again\nfrom the Even app on your phone.\n\nTap to try again.`
  await lens.text(body)
  renderPhone()
}

async function listen() {
  state.screen = 'listening'
  pcm = []
  listenStart = Date.now()
  await lens.text(listeningText(0))
  const micOk = await bridge.audioControl(true).catch(() => false)
  if (micOk === false) return message("The glasses mic didn't start.\nCheck Ginn's microphone permission in the Even app, then tap to try again.", home)
  log('mic on')
  stopTicker()
  ticker = window.setInterval(() => {
    const s = Math.floor((Date.now() - listenStart) / 1000)
    if (s >= limits.listen) return void finishListening()
    lens.update(listeningText(s))
  }, 1000)
  renderPhone()
}

const listeningText = (s: number) =>
  `Listening... 0:${String(s).padStart(2, '0')}\nWho, then what you promised:\n"Alex, Hyperliquid. Wants the deck.\nIntro him to Omar. Call Tuesday."\n\nTap when done · double-tap to cancel`

async function finishListening() {
  stopTicker()
  await bridge.audioControl(false)
  const total = pcm.reduce((n, c) => n + c.length, 0)
  log(`mic off, ${(total / 32000).toFixed(1)} s of audio`)
  const buf = new Uint8Array(total)
  let o = 0
  for (const c of pcm) {
    buf.set(c, o)
    o += c.length
  }
  pcm = []
  // Dev only: ?say=... stands in for the mic when testing in the simulator without one.
  const devSay = new URLSearchParams(location.search).get('say')
  if (devSay) return typed(devSay)
  if (total < 16000) return message("Didn't hear anything.\nTap and try again, a bit closer.", home)
  await working('Got it. Ginn is on it...')
  try {
    open(await api.debriefPcm(buf))
  } catch (e) {
    fail(e)
  }
}

async function working(msg: string) {
  state.screen = 'working'
  await lens.text(msg)
  renderPhone()
}

/** Entry point for a new or reopened draft. */
export function open(d: Draft) {
  state.draft = d
  log(`heard: "${d.transcript}" (${d.parser})`)
  if (d.status === 'needs_pick') return pick()
  return review()
}

async function pick() {
  const d = state.draft!
  state.screen = 'pick'
  const items = [...d.candidates.map(c => c.contact.name), 'Someone else (choose on phone)', 'Cancel']
  await lens.list(`Who was it? You said "${d.person.spokenName || '?'}"${d.person.company ? ', ' + d.person.company : ''}`, items, 60)
  renderPhone()
}

async function review() {
  const d = state.draft!
  state.screen = 'review'
  const on = d.actions.filter(a => a.approved && !(a.kind === 'intro' && !a.other)).length
  const head = `${who(d)}${d.person.company && !who(d).includes(d.person.company) ? ' · ' + d.person.company : ''}\n${on} ready · tap one to read it`
  await lens.list(head, [`Send ${on === d.actions.length ? 'all ' : ''}${on}`, ...d.actions.map(a => actionLine(a, d)), 'Discard'], 64)
  renderPhone()
}

async function detail(a: Action) {
  const d = state.draft!
  state.screen = 'detail'
  state.detail = a
  let head: string
  let items: string[]
  if (a.kind === 'intro' && !a.other) {
    head = `Intro ${first(who(d))} to ${a.otherName}.\nWhich ${a.otherName}?`
    items = [...(a.otherCandidates ?? []).map(c => c.contact.name), 'Skip the intro']
  } else {
    const label = a.kind === 'dm' ? `DM to ${who(d)} · ${a.when}` : a.kind === 'intro' ? `Group: you + ${first(who(d))} + ${first(a.other?.name)}` : a.kind === 'meeting' ? `Calendar · ${a.when}` : `Reminder · ${a.when}`
    head = `${label}\n${lens.block(a.text, 300)}`
    items = [a.approved ? 'Keep it' : 'Turn it on', a.approved ? 'Skip it' : 'Leave it off']
  }
  await lens.list(head, items, 196)
  renderPhone()
}

async function send() {
  const d = state.draft!
  await working('Sending...')
  try {
    state.draft = await api.approve(d.id)
    sent()
  } catch (e) {
    fail(e)
  }
}

async function sent() {
  const d = state.draft!
  state.screen = 'sent'
  sentAt = Date.now()
  // Timers can be paused when the phone is pocketed, so the undo window is decided by the clock at the moment you tap.
  const draw = (closing = false) => {
    const lines = d.actions.filter(a => a.status !== 'skipped').map(a => '- ' + doneLine(a, d))
    return `Done. ${first(who(d))} won't be ghosted.\n${lines.join('\n')}\n\n${closing ? 'Tap to close' : `Tap within ${limits.undo}s to undo`}`
  }
  await lens.text(draw())
  stopTicker()
  ticker = window.setTimeout(async () => {
    try {
      state.draft = await api.draft(d.id)
    } catch {
      /* keep last state */
    }
    if (state.screen === 'sent') await lens.text(draw(true))
    renderPhone()
  }, limits.undo * 1000 + 1500)
  renderPhone()
}

async function next() {
  state.screen = 'next'
  try {
    const n = await api.next()
    if (!n) return message('No meetings coming up from your promises.\n\nSwipe up or tap to go back.', home)
    await lens.text(
      `NEXT: ${n.title}\n${n.when} · met ${n.lastMet}\n\nYou promised, done:\n${n.sent.map(s => '- ' + s).join('\n') || '- nothing yet'}\n${n.open.length ? 'Still open:\n' + n.open.map(s => '- ' + s).join('\n') : 'Nothing open. You are clear.'}`,
    )
  } catch (e) {
    fail(e)
  }
  renderPhone()
}

let afterMessage: (() => void) | null = null
async function message(m: string, then: () => void) {
  stopTicker()
  state.screen = 'message'
  afterMessage = then
  await lens.text(m)
  renderPhone()
}

function fail(e: unknown) {
  const msg = e instanceof ApiError && e.status === 401 ? 'Not paired. Open Ginn on your phone to pair.' : (e as Error).message
  state.error = msg
  log(`error: ${msg}`)
  message(`${msg}\n\nTap to go back.`, home)
}

// ───────────────────────── input ─────────────────────────

function typeOf(env?: { eventType?: OsEventTypeList }) {
  if (!env) return null
  return env.eventType ?? OsEventTypeList.CLICK_EVENT
}

async function onTap() {
  switch (state.screen) {
    case 'home':
      return state.serverOk ? listen() : home()
    case 'listening':
      return finishListening()
    case 'sent': {
      const d = state.draft!
      const live = d.actions.some(a => a.status === 'queued') && Date.now() - sentAt < limits.undo * 1000
      stopTicker()
      if (!live) return home()
      await working('Undoing...')
      try {
        state.draft = await api.undo(d.id)
        log('undone')
        return message('Undone. Nothing went out.', home)
      } catch (e) {
        return fail(e)
      }
    }
    case 'message':
      return afterMessage ? afterMessage() : home()
    case 'next':
      return home()
  }
}

async function onListClick(index: number) {
  const d = state.draft
  if (!d) return
  try {
    if (state.screen === 'pick') {
      if (index < d.candidates.length) {
        state.draft = await api.pick(d.id, d.candidates[index].contact.id)
        return review()
      }
      if (index === d.candidates.length) return message(`Choose who it was on your phone.\n\nTap to go back.`, pick)
      await api.discard(d.id)
      return home()
    }
    if (state.screen === 'review') {
      if (index === 0) return send()
      if (index === d.actions.length + 1) {
        await api.discard(d.id)
        log('discarded')
        return home()
      }
      return detail(d.actions[index - 1])
    }
    if (state.screen === 'detail' && state.detail) {
      const a = state.detail
      if (a.kind === 'intro' && !a.other) {
        const c = a.otherCandidates ?? []
        state.draft = index < c.length ? await api.pick(d.id, c[index].contact.id, a.id) : await api.toggle(d.id, a.id, false)
      } else {
        state.draft = await api.toggle(d.id, a.id, index === 0)
      }
      return review()
    }
  } catch (e) {
    fail(e)
  }
}

async function onDoubleTap() {
  switch (state.screen) {
    case 'home':
      return lens.exit() // root: always lets the user leave
    case 'listening':
      stopTicker()
      await bridge.audioControl(false)
      pcm = []
      return home()
    case 'detail':
      return review()
    default:
      return home()
  }
}

async function handle(fn: () => unknown) {
  if (busy) return
  busy = true
  try {
    await fn()
  } finally {
    busy = false
  }
}

async function boot() {
  mountPhone()
  bridge = await waitForEvenAppBridge()
  lens.initLens(bridge)

  bridge.onEvenHubEvent(event => {
    const chunk = event.audioEvent?.audioPcm
    if (chunk && state.screen === 'listening') pcm.push(chunk)

    const sys = typeOf(event.sysEvent)
    const txt = typeOf(event.textEvent)
    const lst = typeOf(event.listEvent)

    if (sys === OsEventTypeList.DOUBLE_CLICK_EVENT || txt === OsEventTypeList.DOUBLE_CLICK_EVENT || lst === OsEventTypeList.DOUBLE_CLICK_EVENT) return void handle(onDoubleTap)
    if (event.listEvent && lst === OsEventTypeList.CLICK_EVENT) return void handle(() => onListClick(event.listEvent!.currentSelectItemIndex ?? 0))
    if (sys === OsEventTypeList.CLICK_EVENT || txt === OsEventTypeList.CLICK_EVENT) return void handle(onTap)
    if (txt === OsEventTypeList.SCROLL_BOTTOM_EVENT && state.screen === 'home') return void handle(next)
    if (txt === OsEventTypeList.SCROLL_TOP_EVENT && state.screen === 'home' && state.today.ghosted) return void handle(reopenWaiting)
    if ((txt === OsEventTypeList.SCROLL_TOP_EVENT || txt === OsEventTypeList.SCROLL_BOTTOM_EVENT) && state.screen === 'next') return void handle(home)
    if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      stopTicker()
      bridge.audioControl(false)
    }
  })

  await home()
}

async function reopenWaiting() {
  const t = await api.today()
  const d = t.drafts.find(x => x.status === 'ready' || x.status === 'needs_pick')
  if (d) return open(d)
  return home()
}

// The phone page can type a debrief (noisy room, or testing in the simulator without a mic).
export async function typed(text: string) {
  stopTicker()
  if (state.screen === 'listening') await bridge.audioControl(false)
  await working('Got it. Ginn is on it...')
  try {
    open(await api.debriefText(text, 'phone'))
  } catch (e) {
    fail(e)
  }
}

export const actions = { home, review, send, open, typed, refresh: renderPhone }
;(window as unknown as { ginn: unknown }).ginn = { state, ...actions }

boot()
