// npm test — offline checks: rules parser, name matching, full mock flow (approve → outbox → undo).
process.env.GINN_UNDO_SECONDS = '1'
process.env.ANTHROPIC_API_KEY = ''
process.env.TG_API_ID = ''

const { parseWithRules } = await import('./parse.js')
const { matchContact } = await import('./match.js')
const { MockChannel } = await import('./channels/mock.js')
const { db } = await import('./store.js')
const engine = await import('./engine.js')

let pass = 0
let fail = 0
const ok = (cond: boolean, label: string, extra?: unknown) => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && extra !== undefined ? '  →  ' + JSON.stringify(extra) : ''}`)
}

const s = { ...db.settings, timezone: 'Asia/Dubai', myCompany: 'RocketX', defaultEvent: 'Daos Hub', snippets: { 'listing deck': 'https://example.com/deck' } }

// 1. parser
const cases: { text: string; person: string; company?: string; kinds: string[]; other?: string }[] = [
  { text: 'Alex, Hyperliquid. Wants the listing deck. Intro him to Omar. Call next Tuesday.', person: 'Alex', company: 'Hyperliquid', kinds: ['dm', 'intro', 'meeting'], other: 'Omar' },
  { text: 'Just met Priya from Polygon, she wants our API docs, set up a demo on Friday at 3pm', person: 'Priya', company: 'Polygon', kinds: ['dm', 'meeting'] },
  { text: 'Met Daniel Okafor. Introduce him to Sara Kim.', person: 'Daniel Okafor', kinds: ['dm', 'intro'], other: 'Sara Kim' },
  { text: 'Mei Lin from TON. Remind me to check their grant program tomorrow.', person: 'Mei Lin', company: 'TON', kinds: ['dm', 'reminder'] },
  { text: 'Talked to Rahul. Coffee next week.', person: 'Rahul', kinds: ['dm', 'meeting'] },
]
for (const c of cases) {
  const p = parseWithRules(c.text, s)
  const kinds = p.actions.map(a => a.kind).sort()
  ok(p.personName === c.person, `person "${c.person}"`, p.personName)
  if (c.company) ok(p.company === c.company, `company "${c.company}"`, p.company)
  ok(JSON.stringify(kinds) === JSON.stringify([...c.kinds].sort()), `actions ${c.kinds.join('+')}`, kinds)
  if (c.other) ok(p.actions.find(a => a.kind === 'intro')?.otherName === c.other, `intro to ${c.other}`, p.actions)
  const m = p.actions.find(a => a.kind === 'meeting')
  if (m) ok(Boolean(m.when && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(m.when)), `meeting time resolved (${m.when})`, m)
}
const deck = parseWithRules(cases[0].text, s).actions.find(a => a.kind === 'dm')!
ok(deck.text.includes('https://example.com/deck'), 'snippet link added to DM', deck.text)

// 2. matching
const contacts = await new MockChannel().contacts()
const m1 = matchContact('Alex', 'Hyperliquid', contacts)
ok(m1.contact?.name === 'Alex Chen | Hyperliquid', 'Alex + Hyperliquid → Alex Chen | Hyperliquid', m1)
const m2 = matchContact('Alex', null, contacts)
ok(!m2.contact && m2.candidates.length >= 2, 'Alex alone → ambiguous, 2+ candidates', m2)
ok(matchContact('Omar', null, contacts).contact?.name === 'Omar Haddad', 'Omar → Omar Haddad')
ok(matchContact('Pria', null, contacts).contact?.name === 'Priya Nair', 'mis-heard "Pria" → Priya Nair')
ok(!matchContact('Zed', null, contacts).contact, 'unknown name → no match')

// 3. full mock flow
db.settings = s
db.outbox = []
const d = await engine.createDraft(cases[0].text, 'text')
ok(d.status === 'ready' && Boolean(d.contact?.name.startsWith('Alex Chen')), 'draft ready, matched Alex Chen', d.contact)
ok(d.actions.find(a => a.kind === 'intro')?.other?.name === 'Omar Haddad', 'intro other = Omar Haddad')
await engine.approve(d.id)
ok(d.actions.every(a => a.status === 'queued' || a.status === 'sent'), 'all actions queued after approve', d.actions.map(a => a.status))
await new Promise(r => setTimeout(r, 1500))
ok(db.outbox.some(o => o.kind === 'dm' && o.to.startsWith('Alex Chen')), 'DM delivered to Alex', db.outbox)
ok(db.outbox.some(o => o.kind === 'intro' && o.to.includes('Omar Haddad')), 'intro group created with Omar', db.outbox)

const d2 = await engine.createDraft('Sara Kim. Wants our pitch deck.', 'text')
await engine.approve(d2.id)
await engine.undoAll(d2.id)
await new Promise(r => setTimeout(r, 1500))
ok(d2.actions[0].status === 'undone' && !db.outbox.some(o => o.to === 'Sara Kim'), 'undo stops the message')
const t = engine.today()
ok(t.met >= 2 && t.ghosted === 0, `today: ${t.met} met · ${t.sent} sent · ${t.ghosted} ghosted`)
ok(Boolean(engine.before(d.contact!.id)?.upcoming.length), 'before card shows the upcoming call')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
