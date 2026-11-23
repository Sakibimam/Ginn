// Matches a spoken name to your contacts with plain string similarity. No AI involved.
import type { Candidate, Contact } from './types.js'

function norm(s: string) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim()
}

/** Jaro-Winkler similarity, 0..1. */
export function jw(a: string, b: string): number {
  if (a === b) return 1
  if (!a || !b) return 0
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const am = new Array(a.length).fill(false)
  const bm = new Array(b.length).fill(false)
  let matches = 0
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bm[j] || a[i] !== b[j]) continue
      am[i] = bm[j] = true
      matches++
      break
    }
  }
  if (!matches) return 0
  let t = 0
  for (let i = 0, k = 0; i < a.length; i++) {
    if (!am[i]) continue
    while (!bm[k]) k++
    if (a[i] !== b[k]) t++
    k++
  }
  const j = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3
  let p = 0
  while (p < 4 && a[p] === b[p]) p++
  return j + p * 0.1 * (1 - j)
}

export function scoreContact(spoken: string, company: string | null, c: Contact): number {
  const sp = norm(spoken).split(' ').filter(Boolean)
  if (!sp.length) return 0
  const nameTokens = norm(c.name).split(' ').filter(Boolean)
  const user = c.username ? norm(c.username) : ''
  const tokens = [...nameTokens, ...(user ? [user] : [])]
  // first spoken token vs best contact token
  let s = Math.max(0, ...tokens.map(t => jw(sp[0], t)))
  // surname spoken too: reward when it also matches
  if (sp.length > 1) {
    const s2 = Math.max(0, ...tokens.map(t => jw(sp[sp.length - 1], t)))
    s = (s * 2 + s2) / 3
  }
  // company hint: Telegram names often carry it ("Alex | Hyperliquid", @alex_hl)
  if (company) {
    const co = norm(company).replace(/ /g, '')
    const hay = (norm(c.name) + ' ' + user).replace(/ /g, '')
    if (co.length >= 3 && (hay.includes(co) || (co.length >= 4 && hay.includes(co.slice(0, 4))))) s += 0.12
  }
  return Math.min(1, s)
}

export interface MatchResult {
  contact: Contact | null
  candidates: Candidate[]
}

export function matchContact(spoken: string, company: string | null, contacts: Contact[]): MatchResult {
  const ranked = contacts
    .map(contact => ({ contact, score: scoreContact(spoken, company, contact) }))
    .filter(c => c.score >= 0.7)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
  const [top, second] = ranked
  const confident = top && top.score >= 0.9 && (!second || top.score - second.score >= 0.08)
  return { contact: confident ? top.contact : null, candidates: ranked }
}
