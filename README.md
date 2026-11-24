# Ginn

**Nobody means to ghost the people they meet. Ginn makes sure you don't.**

Tap your Even G2 after a conversation and say one line:

> "Alex, Hyperliquid. Wants the listing deck. Intro him to Omar. Call next Tuesday."

Ginn turns it into real follow-ups and asks for one tap:

- a **Telegram DM** to Alex, from your own account, with the deck link
- a **Telegram group** "RocketX <> Hyperliquid" with Alex and Omar and your intro line (invite link if Omar blocks group adds)
- a **Google Calendar** event "Call with Alex (Hyperliquid)" next Tuesday 11:00

Tap **Send all**. You have 20 seconds to undo. At the end of the day the lens shows `14 met · 31 sent · 0 ghosted`.

Built for **Heads Up: Even Realities Hackathon** (Track 04 AI Assistants & Work, second track 01 Messaging).

## How it works

```
G2 mic (16 kHz PCM) ──► your Ginn server ──► whisper.cpp (local, free)
                                     │
                                     ├─► Claude: your words → actions (JSON)      ← only your own words
                                     ├─► contact match (plain string similarity) ← Telegram names never leave the server
                                     ├─► Telegram (MTProto user account): scheduled DM, group, Saved Messages
                                     └─► Google Calendar: event
lens: review list ◄─────────────────────┘    tap = approve, double-tap = back
```

| Folder | What |
|---|---|
| `glasses/` | The Even Hub app (Vite + TypeScript, Even Hub SDK 0.0.16). Lens screens + phone-side companion. No keys inside. |
| `server/` | Node + Hono. Speech-to-text, parser, Telegram, Calendar, undo, daily stats, setup page, Ginn Lite. |

## Run it (5 minutes, no accounts needed)

Requirements: Node 20+, `ffmpeg`, `whisper-cpp` (`brew install whisper-cpp ffmpeg`) and a model:
`mkdir -p ~/.cache/whisper && curl -L -o ~/.cache/whisper/ggml-small.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin`

```bash
# 1. server (mock Telegram + offline parser until you add keys)
cd server && npm install && cp .env.example .env && npm start
#    → prints the pairing code; setup page at http://localhost:8787

# 2. glasses app
cd ../glasses && npm install && npm run dev

# 3. simulator (uses your Mac's microphone)
npm i -g @evenrealities/evenhub-simulator
evenhub-simulator http://localhost:5173
```

Tap the glasses in the simulator, speak your debrief, tap again. Or type it in the phone panel.
Testing without a mic: `evenhub-simulator "http://localhost:5173/?say=Alex,%20Hyperliquid.%20Wants%20the%20deck."`

### Real accounts
- **Telegram:** create an app at my.telegram.org, put `TG_API_ID` / `TG_API_HASH` in `server/.env`, restart, log in on the setup page (phone → code → 2-step password if you have one).
- **Claude:** `ANTHROPIC_API_KEY` in `server/.env`. Without it a built-in rules parser handles the common patterns.
- **Google Calendar:** OAuth web client in testing mode, redirect `<PUBLIC_URL>/auth/google/callback`, then "Connect" on the setup page.

### Real G2
Expose the server (e.g. `cloudflared tunnel --url http://localhost:8787`), set `PUBLIC_URL`, add the URL to the
`network` whitelist in `glasses/app.json`, `npm run pack`, install the `.ehpk`, then pair in the phone panel with the code.
Requests from outside this machine need the pairing token.

## Ginn Lite
`http://<server>/lite`: anyone can try Ginn on their phone with no login. Hold to talk, get the messages, press
"Send in Telegram" or "Add to calendar" yourself. Only anonymous usage counts are stored, never what people say.

## Safety and Telegram terms
- **No Telegram data goes to an AI.** Claude sees only the sentence you spoke plus your own settings. Contact names are
  matched on the server with plain string similarity.
- **Nothing reaches another person without your tap.** Every message waits 20 s in Telegram's scheduled queue so you can undo.
- **Keys live on your server only.** The `.ehpk` contains no API keys. The Telegram session and Google tokens are encrypted at rest (AES-256-GCM).
- Use a secondary Telegram account for demos. Log out from the setup page or Telegram's Active Sessions at any time.

## Tests
`cd server && npm test`: parser (people, companies, events, intros, dates), name matching (two Alexes, mis-heard names),
and the full flow on the mock (approve → delivered → undo stops it).

## What existed before 2026-11-23
- The glasses scaffold started from Even Realities' official `evenhub-templates/asr` template (Vite config, `index.html`, event-routing pattern).
- Open-source libraries: Even Hub SDK, GramJS (`telegram`), Hono, Anthropic SDK, zod, chrono-node, luxon, whisper.cpp.
- Everything else (server, parser, matcher, channels, lens screens, Lite) was written during the hackathon week.

## Roadmap
Gmail next (same channel interface as Telegram), then WhatsApp (pre-filled message you tap send on), LinkedIn and X where their APIs allow.
