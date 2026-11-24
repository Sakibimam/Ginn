// Phone side of the app (inside the Even Realities app). Pairing, full message text, edits, typing a debrief.
import { api, conn, type Draft } from './api'
import { state, actions } from './main'

let root: HTMLElement
let health: Awaited<ReturnType<typeof api.health>> | null = null

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export function mountPhone() {
  root = document.querySelector('#app')!
  injectStyles()
  root.addEventListener('click', onClick)
  checkHealth()
  setInterval(checkHealth, 15000)
}

async function checkHealth() {
  try {
    health = await api.health()
  } catch {
    health = null
  }
  renderPhone()
}

export function renderPhone() {
  if (!root) return
  const d = state.draft
  const t = state.today
  const paired = state.serverOk
  root.innerHTML = `
  <main>
    <header>
      <div class="brand">ginn<span>.</span></div>
      <div class="chips">
        <span class="chip ${paired ? 'ok' : 'bad'}">${paired ? 'server' : 'offline'}</span>
        ${health ? `<span class="chip ${health.telegram.connected ? 'ok' : 'warn'}">${health.telegram.mock ? 'telegram: demo' : health.telegram.connected ? 'telegram' : 'telegram: log in'}</span>
        <span class="chip ${health.calendar.connected ? 'ok' : 'warn'}">${health.calendar.connected ? 'calendar' : 'calendar: off'}</span>` : ''}
      </div>
    </header>

    ${paired ? '' : pairBox()}

    <section class="stats">
      <div><b>${t.met}</b><small>met</small></div>
      <div><b>${t.sent}</b><small>sent</small></div>
      <div class="${t.ghosted ? 'hot' : ''}"><b>${t.ghosted}</b><small>ghosted</small></div>
    </section>

    ${d ? draftCard(d) : `<p class="hint">On the glasses: tap, say who you met and what you promised, tap again.</p>`}

    <section class="card">
      <h3>Type instead</h3>
      <textarea id="typed" rows="3" placeholder="Alex, Hyperliquid. Wants the listing deck. Intro him to Omar. Call next Tuesday."></textarea>
      <button data-act="typed">Give it to Ginn</button>
    </section>

    <section class="card small">
      <h3>Server</h3>
      <p>${esc(conn.url)} · parser: ${esc(health?.parser ?? '?')}${health?.telegram.me ? ' · ' + esc(health.telegram.me) : ''}</p>
      <p>Telegram login and Google Calendar: open <b>${esc(conn.url)}</b> in your phone browser.</p>
      <button class="ghost" data-act="repair">Pair another server</button>
    </section>

    <details class="card small"><summary>Activity</summary><pre>${esc(state.log.join('\n'))}</pre></details>
  </main>`
}

function pairBox() {
  return `<section class="card pair">
    <h3>Pair with your Ginn server</h3>
    <label>Server URL<input id="srv" value="${esc(conn.url)}" autocapitalize="off"></label>
    <label>Pairing code (shown when the server starts)<input id="code" inputmode="numeric" maxlength="6"></label>
    <button data-act="pair">Pair</button>
    ${state.error ? `<p class="err">${esc(state.error)}</p>` : ''}
  </section>`
}

function draftCard(d: Draft) {
  const head = `<h3>${esc(d.contact?.name ?? `"${d.person.spokenName}"`)}${d.person.company ? ` <small>${esc(d.person.company)}</small>` : ''}</h3>
    <p class="quote">“${esc(d.transcript)}”</p>`
  if (d.status === 'needs_pick')
    return `<section class="card live">${head}
      <p>Who was it?</p>
      ${d.candidates.map(c => `<button class="ghost" data-act="pick" data-id="${c.contact.id}">${esc(c.contact.name)}</button>`).join('')}
      <input id="search" placeholder="Search your contacts"><button class="ghost" data-act="search">Search</button>
      <div id="results"></div>
    </section>`
  const rows = d.actions
    .map(
      a => `<div class="act ${a.approved ? '' : 'off'} st-${a.status}">
        <div class="row"><b>${labelOf(a.kind)}${a.kind === 'intro' ? ' + ' + esc(a.other?.name ?? a.otherName ?? '?') : ''}</b><span>${esc(a.when)}</span></div>
        ${d.status === 'ready' && a.status === 'pending'
          ? `<textarea data-edit="${a.id}" rows="${Math.min(5, Math.ceil(a.text.length / 38))}">${esc(a.text)}</textarea>
             <label class="tog"><input type="checkbox" data-toggle="${a.id}" ${a.approved ? 'checked' : ''}> send this</label>`
          : `<p>${esc(a.text)}</p><small>${esc(a.status)}${a.detail ? ' · ' + esc(a.detail) : ''}${a.error ? ' · ' + esc(a.error) : ''}</small>`}
      </div>`,
    )
    .join('')
  const buttons =
    d.status === 'ready'
      ? `<button data-act="approve">Send ${d.actions.filter(a => a.approved).length}</button><button class="ghost" data-act="discard">Discard</button>`
      : d.actions.some(a => a.status === 'queued')
        ? `<button class="ghost" data-act="undo">Undo what's still waiting</button>`
        : ''
  return `<section class="card live">${head}${rows}${buttons}</section>`
}

const labelOf = (k: string) => ({ dm: 'Telegram DM', intro: 'Intro group', meeting: 'Calendar', reminder: 'Reminder' })[k] ?? k

async function onClick(e: Event) {
  const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null
  if (!el) return
  const act = el.dataset.act
  const d = state.draft
  try {
    if (act === 'pair') {
      const url = (document.querySelector('#srv') as HTMLInputElement).value.trim()
      const code = (document.querySelector('#code') as HTMLInputElement).value.trim()
      await api.pair(url, code)
      state.error = ''
      await checkHealth()
      await actions.home()
    } else if (act === 'repair') {
      state.serverOk = false
      renderPhone()
    } else if (act === 'typed') {
      const v = (document.querySelector('#typed') as HTMLTextAreaElement).value.trim()
      if (v) await actions.typed(v)
    } else if (d && act === 'pick') {
      state.draft = await api.pick(d.id, el.dataset.id!)
      await actions.review()
    } else if (d && act === 'search') {
      const q = (document.querySelector('#search') as HTMLInputElement).value
      const res = await fetch(`${conn.url}/api/contacts/search?q=${encodeURIComponent(q)}`, { headers: conn.token ? { authorization: `Bearer ${conn.token}` } : {} }).then(r => r.json())
      document.querySelector('#results')!.innerHTML = (res as { id: string; name: string }[])
        .map(c => `<button class="ghost" data-act="pick" data-id="${c.id}">${esc(c.name)}</button>`)
        .join('')
      return
    } else if (d && act === 'approve') {
      await saveEdits(d)
      await actions.send()
    } else if (d && act === 'discard') {
      await api.discard(d.id)
      await actions.home()
    } else if (d && act === 'undo') {
      state.draft = await api.undo(d.id)
      await actions.home()
    }
  } catch (err) {
    state.error = (err as Error).message
    alertBox(state.error)
  }
  renderPhone()
}

async function saveEdits(d: Draft) {
  for (const ta of document.querySelectorAll<HTMLTextAreaElement>('textarea[data-edit]')) {
    const a = d.actions.find(x => x.id === ta.dataset.edit)
    if (a && ta.value.trim() && ta.value.trim() !== a.text) state.draft = await api.edit(d.id, a.id, ta.value.trim())
  }
  for (const cb of document.querySelectorAll<HTMLInputElement>('input[data-toggle]')) {
    const a = d.actions.find(x => x.id === cb.dataset.toggle)
    if (a && a.approved !== cb.checked) state.draft = await api.toggle(d.id, a.id, cb.checked)
  }
}

function alertBox(msg: string) {
  const n = document.createElement('div')
  n.className = 'toast'
  n.textContent = msg
  document.body.appendChild(n)
  setTimeout(() => n.remove(), 4000)
}

function injectStyles() {
  const css = `
  :root { color-scheme: dark; --bg:#1b1b1b; --card:#262626; --line:#3a3a3a; --text:#ececec; --dim:#9a9a9a; --g:#3CFA44; --warn:#ffb020; --bad:#ff453a; }
  html,body { margin:0; background:var(--bg); color:var(--text); font:15px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif; -webkit-text-size-adjust:100%; }
  main { max-width:560px; margin:0 auto; padding:16px; display:flex; flex-direction:column; gap:12px; }
  header { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }
  .brand { font-size:26px; font-weight:800; letter-spacing:-0.03em; } .brand span { color:var(--g); }
  .chips { display:flex; gap:6px; flex-wrap:wrap; }
  .chip { font-size:11px; padding:3px 8px; border-radius:99px; border:1px solid var(--line); color:var(--dim); text-transform:uppercase; letter-spacing:.04em; }
  .chip.ok { color:var(--g); border-color:var(--g); } .chip.warn { color:var(--warn); border-color:#6b5310; } .chip.bad { color:var(--bad); border-color:var(--bad); }
  .stats { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
  .stats div { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:10px; text-align:center; }
  .stats b { display:block; font-size:26px; } .stats small { color:var(--dim); } .stats .hot b { color:var(--warn); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; display:flex; flex-direction:column; gap:8px; }
  .card.live { border-color:var(--g); }
  .card h3 { margin:0; font-size:17px; } .card h3 small { color:var(--dim); font-weight:400; }
  .card.small p { margin:0; color:var(--dim); font-size:13px; word-break:break-all; }
  .quote { margin:0; color:var(--dim); font-style:italic; }
  .act { border-top:1px solid var(--line); padding-top:8px; display:flex; flex-direction:column; gap:6px; }
  .act.off { opacity:.5; } .act p { margin:0; } .act small { color:var(--dim); } .st-failed small { color:var(--bad); }
  .row { display:flex; justify-content:space-between; gap:8px; } .row span { color:var(--dim); font-size:13px; }
  textarea, input { background:#1f1f1f; color:var(--text); border:1px solid var(--line); border-radius:10px; padding:10px; font:inherit; width:100%; box-sizing:border-box; }
  label { display:flex; flex-direction:column; gap:4px; color:var(--dim); font-size:13px; }
  label.tog { flex-direction:row; align-items:center; gap:8px; } label.tog input { width:auto; }
  button { background:var(--g); color:#0b0b0b; border:0; border-radius:10px; padding:12px; font:600 15px system-ui; }
  button.ghost { background:transparent; color:var(--text); border:1px solid var(--line); }
  .hint { color:var(--dim); text-align:center; margin:4px 0; }
  .err { color:var(--bad); margin:0; }
  pre { white-space:pre-wrap; font-size:12px; color:var(--dim); margin:8px 0 0; }
  summary { cursor:pointer; color:var(--dim); }
  .toast { position:fixed; left:16px; right:16px; bottom:16px; background:#3a1512; color:#ffd7d3; padding:12px; border-radius:10px; }`
  const s = document.createElement('style')
  s.textContent = css
  document.head.appendChild(s)
}
