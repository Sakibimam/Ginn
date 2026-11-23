// Turns one spoken debrief into planned follow-ups.
import * as chrono from 'chrono-node'
import { DateTime } from 'luxon'
import type { ActionKind, Settings } from './types.js'

export interface ParsedAction {
  kind: ActionKind
  text: string
  otherName: string | null
  /** Local wall-clock time in the user's timezone, 'YYYY-MM-DDTHH:mm', or null for "as soon as approved". */
  when: string | null
}

export interface ParsedDebrief {
  personName: string
  company: string | null
  event: string | null
  actions: ParsedAction[]
  parser: 'claude' | 'rules'
}

// ───────────────────────── rules parser (free, offline fallback) ─────────────────────────

const NAME = String.raw`[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)?`
const first = (n: string) => n.split(/\s+/)[0]

function splitClauses(t: string): string[] {
  return t
    .replace(/\s+/g, ' ')
    .split(/[.;!?]+|,\s*(?=(?:and\s+|then\s+|also\s+)?(?:she|he|they|wants|needs|asked|send|share|intro|introduce|connect|call|meet|set up|schedule|book|remind|follow|ping)\b)|\s+(?:and then|and also|then)\s+|\s+and\s+(?=(?:intro|introduce|connect|call|meet|set up|schedule|book|remind|send|share)\b)/i)
    .map(s => s.trim().replace(/^(?:and|also|then|so)\s+/i, ''))
    .filter(Boolean)
}

function findPerson(clauses: string[]): { name: string; company: string | null; rest: string[] } {
  const c0 = clauses[0] ?? ''
  const pats = [
    new RegExp(String.raw`^(?:i\s+)?(?:just\s+)?(?:met|meeting with|talked to|spoke (?:to|with)|chatted with|had coffee with)\s+(${NAME})(?:\s+(?:from|at|of|with)\s+(.+))?$`, 'iu'),
    new RegExp(String.raw`^(${NAME})\s+(?:from|at|of)\s+(.+)$`, 'u'),
    new RegExp(String.raw`^(${NAME})$`, 'u'),
  ]
  for (const p of pats) {
    const m = c0.match(p)
    if (m) return { name: m[1], company: m[2]?.trim() ?? null, rest: clauses.slice(1) }
  }
  // "Alex, Hyperliquid" was split into two clauses only if the second started with a verb, so try comma form on the raw first clause.
  const comma = c0.match(new RegExp(String.raw`^(${NAME})\s*,\s*(.+)$`, 'u'))
  if (comma) return { name: comma[1], company: comma[2].trim(), rest: clauses.slice(1) }
  const any = c0.match(new RegExp(NAME, 'u'))
  return { name: any?.[0] ?? '', company: null, rest: clauses.slice(1) }
}

function localWhen(text: string, s: Settings, defaultHour = 11): string | null {
  const now = DateTime.now().setZone(s.timezone)
  const res = chrono.parse(text, { instant: now.toJSDate(), timezone: now.offset }, { forwardDate: true })[0]
  if (!res) return null
  const c = res.start
  const dt = DateTime.fromObject(
    {
      year: c.get('year') ?? now.year,
      month: c.get('month') ?? now.month,
      day: c.get('day') ?? now.day,
      hour: c.isCertain('hour') ? (c.get('hour') ?? defaultHour) : defaultHour,
      minute: c.isCertain('hour') ? (c.get('minute') ?? 0) : 0,
    },
    { zone: s.timezone },
  )
  return dt.toFormat("yyyy-LL-dd'T'HH:mm")
}

function nextWorkday(s: Settings): string {
  let d = DateTime.now().setZone(s.timezone).plus({ days: 1 })
  while (d.weekday > 5) d = d.plus({ days: 1 })
  return d.set({ hour: 11, minute: 0 }).toFormat("yyyy-LL-dd'T'HH:mm")
}

function snippetFor(thing: string, s: Settings): string | null {
  const t = thing.toLowerCase()
  for (const [k, v] of Object.entries(s.snippets)) if (t.includes(k.toLowerCase())) return v
  return null
}

export function parseWithRules(transcript: string, s: Settings): ParsedDebrief {
  const clauses = splitClauses(transcript)
  const { name, company, rest } = findPerson(clauses)
  const who = first(name) || 'there'
  const event = s.defaultEvent
  const actions: ParsedAction[] = []

  for (const cl of rest) {
    let m: RegExpMatchArray | null
    if ((m = cl.match(new RegExp(String.raw`\b(?:intro(?:duce)?|connect)\b.*?\b(?:to|with)\s+(${NAME})`, 'iu')))) {
      const other = m[1]
      actions.push({
        kind: 'intro',
        otherName: other,
        when: null,
        text: `Hi both! ${first(other)}, meet ${who}${company ? ` from ${company}` : ''}. ${who}, meet ${first(other)}. We met at ${event} and I think you two should talk. I'll let you take it from here.`,
      })
    } else if ((m = cl.match(/\bremind me to\s+(.+)/i))) {
      actions.push({ kind: 'reminder', otherName: null, when: localWhen(cl, s, 10), text: m[1].replace(/\s+/g, ' ') })
    } else if ((m = cl.match(/\b(call|meet(?:ing)?|catch[- ]?up|sync|demo|coffee|lunch|dinner|follow[- ]up call)\b/i))) {
      const verb = m[1].toLowerCase().startsWith('meet') ? 'Meeting' : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()
      actions.push({
        kind: 'meeting',
        otherName: null,
        when: localWhen(cl, s) ?? nextWorkday(s),
        text: `${verb} with ${who}${company ? ` (${company})` : ''}`,
      })
    } else if ((m = cl.match(/\b(?:wants|needs|asked for|asked about|requested|interested in|send(?: him| her| them)?|share(?: with him| with her)?)\s+(?:me\s+)?(?:to see\s+)?(?:the|our|a|an|some|my)?\s*(.+)$/i))) {
      const thing = m[1].replace(/\s+/g, ' ').trim()
      const link = snippetFor(thing, s)
      actions.push({
        kind: 'dm',
        otherName: null,
        when: null,
        text: `Great meeting you at ${event}, ${who}! As promised, here's our ${thing}${link ? `: ${link}` : '.'} Happy to walk you through it.`,
      })
    }
  }

  if (!actions.some(a => a.kind === 'dm')) {
    actions.unshift({ kind: 'dm', otherName: null, when: null, text: `Great meeting you at ${event}, ${who}! Let's keep in touch.` })
  }
  return { personName: name, company, event: null, actions, parser: 'rules' }
}

export async function parseDebrief(transcript: string, s: Settings): Promise<ParsedDebrief> {
  return parseWithRules(transcript, s)
}
