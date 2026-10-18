# Alibi Breaker

A detective game where AI suspects lie, and a map proves it.

You question suspects. Every place and time they mention is pinned on a San Francisco map. When someone's story is physically impossible ("I left Joe's at 9:10 and was home by 9:15", but the drive takes 22 minutes), the game flags it. Catch the liar, then accuse.

It ships with two cases:

| Case | You are | The lie |
|---|---|---|
| **The Union Square Heist** | Detective | A diamond thief's alibi doesn't fit the drive times |
| **The Marina Hit-and-Run Claim** | Insurance claims investigator | A claimant says the car never moved, but the gas receipt is across town |

## How it works: two brains plus a map

```
You ask a question
   │
   ▼
BIG model ── plays the suspect (knows the secret, tells the cover story)
   │
   ▼
FAST model ── note-taker: pulls out {place, time}, stress level, a body-language tell
   │
   ▼
Plain code ── checks every claim against the map + evidence (no AI, so it's always right)
   │
   ▼
🚨 "Said Joe's Café at 9:10 and Kestrel Tower at 9:15. The drive takes 22 min."
```

Two safety checks keep the game fair: a claim only counts if the suspect actually named that place and said that time in the answer. Small models sometimes invent places, and this stops them from framing an innocent person.

## Run it

You need Node.js 20+.

```bash
npm install
npm start
```

Open http://localhost:3000.

With no `.env` file it runs in **mock mode**: scripted answers, no AI. Use it to test the UI, or as a backup if a model dies during a demo:

```bash
npm run mock
```

## Pick your models

Copy `.env.example` to `.env` and choose one setup:

**Claude (cloud)**
```
PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-...
```
This defaults to `claude-opus-5-5` for the suspect and `claude-haiku-5-5` for the note-taker. Requests to Opus use server-side refusal fallbacks (`fallbacks: "default"`), so if a safety classifier declines a line, another model answers instead.

**Gemma + Laya on the Snapdragon X laptop (fully local)**

Most local model apps (LM Studio, Nexa, AnythingLLM, Foundry Local, llama.cpp) expose an OpenAI-compatible server. Point the game at it:
```
PROVIDER=local
LOCAL_URL=http://localhost:1234/v1   # whatever port your app shows
BIG_MODEL=gemma-3-4b                 # exact model id from your app
FAST_MODEL=laya                      # exact model id from your app
```
To find the exact model ids: `curl http://localhost:1234/v1/models`

**Ollama**
```
PROVIDER=ollama
BIG_MODEL=gemma3:4b
FAST_MODEL=your-fast-model
```

**Mix and match:** run each brain on a different backend:
```
BIG_PROVIDER=local
BIG_MODEL=gemma-3-4b
FAST_PROVIDER=ollama
FAST_MODEL=qwen2.5:7b
```

The terminal prints which models are running, and so does the start screen. Local models are warmed up at startup, because the first load can take about a minute.

## Write a new case

1. Copy a file in `cases/`, give it a new `id` (must match the filename), and edit it.
2. Click **Change case** in the game. Cases are re-read every time a new game starts, so you don't need to restart.

Key fields:

| Field | What it is |
|---|---|
| `map` | Which file in `maps/` to use (`sf-basic`) |
| `labels` | Wording: "Detective" vs "Claims investigator", "Accuse" vs "Flag as fraud" |
| `crime` | Where and when the incident happened (shown on the map) |
| `watch` | Optional. A place and time window. A suspect's route passing through it gets flagged as suspicious. |
| `suspects[].truth` | What really happened. Only the suspect model sees this. |
| `suspects[].cover` | The story they tell |
| `suspects[].pressure` | How they change the story when cornered |
| `suspects[].guilty` | Exactly one suspect is `true` |
| `evidence[].facts` | Hard facts: `{ suspect, place, time }`. The checker uses these. |
| `suspects[].mock` | Scripted lines for mock mode |

**Design tip:** write the guilty suspect's `cover` so it's impossible on the map, and give innocent suspects stories that fit the drive times. Innocent suspects should still hide *something* (a forgotten alarm, a skipped shift). That makes them nervous, which makes them good red herrings.

If a case file has a mistake (an unknown place id, a bad time format), the game tells you exactly what's wrong when you open it.

## Swap in a real SF map

`maps/sf-basic.json` is a simplified graph: places with x/y positions, and roads with drive minutes. To use your real SF map, export it to the same shape:

```json
{
  "width": 800, "height": 520,
  "places": [{ "id": "cafe", "name": "Joe's Café", "area": "North Beach", "x": 330, "y": 70, "aliases": ["joe's"] }],
  "roads":  [{ "from": "cafe", "to": "jewelers", "minutes": 12, "name": "Stockton Street" }]
}
```

All drive times come from `src/map.js` (`shortestPath`). Replace that function to use real routing, such as OSRM or your map project's router.

## Files

```
server.js          HTTP server + API
src/llm.js         the model switch (claude / ollama / local / mock)
src/game.js        prompts, one interrogation turn, the alibi checker
src/map.js         road graph + shortest drive time
src/case.js        loads and validates case files
src/mock.js        scripted suspects + regex note-taker (no AI)
cases/*.json       the cases
maps/*.json        the maps
public/            the game UI
```
