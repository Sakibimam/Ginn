// Turns one spoken debrief into planned follow-ups.
// Input to the AI is ONLY the wearer's own words plus their own settings. No Telegram data
// (contacts, messages, names from Telegram) is ever sent to an AI model.
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import * as chrono from 'chrono-node'
import { DateTime } from 'luxon'
import { config } from './config.js'
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

const Debrief = z.object({
  person_name: z.string().describe('The person the user just met, as spoken. Empty string if unclear.'),
  company: z.string().nullable().describe('Their company or project, if said.'),
  event: z.string().nullable().describe('Where they met, if said.'),
  actions: z.array(
    z.object({
      kind: z.enum(['dm', 'intro', 'meeting', 'reminder']),
      text: z.string(),
      other_person: z.string().nullable(),
      when: z.string().nullable(),
    }),
  ),
})

const SYSTEM = `You are Ginn. The user just finished an in-person conversation and said one short sentence about it.
Turn it into follow-ups the user will approve with one tap. Return JSON only.

Action kinds:
- "dm": a Telegram message from the user to the person. First person, warm, specific, under 240 characters, no emojis, no hashtags.
  Mention what was promised. If a promised item matches one of the user's snippets, include that link. Never invent links, numbers or facts.
- "intro": a message the user posts in a new group with the person and other_person (the name as spoken). Introduce both in two short
  sentences using only facts from the debrief. Under 300 characters.
- "meeting": a calendar event. text = short title like "Call with Alex (Hyperliquid)". when = local start time.
  If only a day is given, use 11:00. If no day is given, use the next working day at 11:00.
- "reminder": something the user must do that is not a message to the person. text = short note to self. when = local time or null.

Rules:
- Always include at least one "dm" so the person is never left hanging, unless the user says not to message them.
- "when" is local time in the user's timezone, format YYYY-MM-DDTHH:mm, or null. For "dm" use null unless the user names a time.
- Resolve relative dates ("next Tuesday", "tomorrow") from the current local time given below.
- Use only what the user said. Do not add actions they did not ask for, except the default "dm".`

let client: Anthropic | null = null

async function parseWithClaude(transcript: string, s: Settings): Promise<ParsedDebrief> {
  client ??= new Anthropic({ apiKey: config.anthropicKey, timeout: 30_000, maxRetries: 1 })
  const now = DateTime.now().setZone(s.timezone)
  const context = {
    now_local: now.toFormat("cccc yyyy-LL-dd'T'HH:mm"),
    timezone: s.timezone,
    user: { name: s.myName, company: s.myCompany },
    default_event: s.defaultEvent,
    snippets: s.snippets,
    debrief: transcript,
  }
  const res = await client.messages.parse({
    model: config.model,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { effort: 'low', format: zodOutputFormat(Debrief) },
    messages: [{ role: 'user', content: JSON.stringify(context) }],
  })
  if (res.stop_reason === 'refusal' || !res.parsed_output) throw new Error(`Claude returned no plan (${res.stop_reason})`)
  const out = res.parsed_output
  return {
    personName: out.person_name.trim(),
    company: out.company?.trim() || null,
    event: out.event?.trim() || null,
    parser: 'claude',
    actions: out.actions.map(a => ({
      kind: a.kind,
      text: a.text.trim(),
      otherName: a.other_person?.trim() || null,
      when: a.when && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(a.when) ? a.when.slice(0, 16) : null,
    })),
  }
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

const EVENT_WORDS = /\b(party|event|conference|summit|dinner|lunch|breakfast|meetup|booth|side ?event|hackathon|week|hub|panel|mixer|happy hour|afterparty|expo|forum)\b/i

/** "at the Polygon party" is where you met; "from Polygon" / "at Polygon" is the company. */
function splitOrg(raw: string | null): { company: string | null; event: string | null } {
  if (!raw) return { company: null, event: null }
  let company: string | null = null
  let event: string | null = null
  for (const part of raw.split(/\s+(?=at\s)|\s+at\s+/i)) {
    const p = part.replace(/^at\s+/i, '').trim()
    if (!p) continue
    if (EVENT_WORDS.test(p) || /^the\s/i.test(p)) event ??= p.replace(/^the\s+/i, '')
    else company ??= p
  }
  return { company, event }
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
  const part = /\bmorning\b/i.test(text) ? 10 : /\b(lunch|noon)\b/i.test(text) ? 12 : /\bafternoon\b/i.test(text) ? 15 : /\b(evening|tonight|drinks)\b/i.test(text) ? 18 : defaultHour
  defaultHour = part
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
  const found = findPerson(clauses)
  const { name, rest } = found
  const org = splitOrg(found.company)
  const company = org.company
  const who = first(name) || 'there'
  const event = org.event ?? s.defaultEvent
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
  return { personName: name, company, event: org.event, actions, parser: 'rules' }
}

export async function parseDebrief(transcript: string, s: Settings): Promise<ParsedDebrief> {
  if (config.anthropicKey) {
    try {
      return await parseWithClaude(transcript, s)
    } catch (err) {
      console.warn('[parse] Claude failed, using rules parser:', (err as Error).message)
    }
  }
  return parseWithRules(transcript, s)
}
