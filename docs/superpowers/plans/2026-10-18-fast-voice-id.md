# Fast Voice ID Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put an enrolled speaker’s name, relation, and stored description on the glasses as soon as the voiceprint matches, and make portal enrollment actually produce matches on the glasses mic.

**Architecture:** Split “who” from “words”. A new `/api/audio/who` and an early assign inside `/api/audio` publish speaker + blurb to `glassesState` before Whisper. The glasses send a 1.2 s prefix while speech is still going, and poll every 250 ms. Matching uses max-and-centroid scores and enrolls a second clip from the portal.

**Tech Stack:** TypeScript, existing sherpa-onnx TitaNet embeddings, Vite portal, Even Hub glasses app, `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-18-fast-voice-id-design.md`

## Global Constraints

- Voiceprints stay local in `portal/data/`; never send enrollment audio to Groq.
- Do not commit `portal/.env`, `portal/data/`, or `portal/models/`.
- Do not push or commit unless the user asks.
- Groq remains only for transcription and calendar plans; it must not block the name.
- Description on first paint is `person.blurb` (first sentence), not a Groq fact.

## Review Focus

- A who-prefix and the later full clip for the same utterance must not create two guests or flicker the speaker to unknown.
- An unmatched voice is not written to disk before the HTTP response returns.
- Empty transcript after a successful who must keep the name on screen, not clear it.
- Re-recording a person replaces/adds prints without leaving the old `voiceFile` orphaned in uploads if the code already deletes old files.
- Live portal “Test match” must not add the clip to the calendar conversation.

---

### Task 1: Match score uses centroid and 1.0 s clips

**Files:**
- Modify: `portal/server/voices.ts` (`MATCH`, `MIN_SECONDS`, `best`, `assign`, `prepare`)
- Test: `portal/server/voices.test.ts`

**Interfaces:**
- Consumes: existing `createVoices`, `prepare`, `assign`
- Produces: `scoreAgainst(print, prints): number` — max of best-cosine and centroid-cosine; `MIN_SECONDS = 1`

- [ ] **Step 1: Write the failing tests**

`scoreAgainst` of a print against `[same, same]` is 1. `prepare` of a 1.0 s enrolled clip returns a non-null print. `assign` of that clip is the enrolled person.

- [ ] **Step 2: Run `node --test --test-name-pattern="centroid|1.0 s" portal/server/voices.test.ts`**

Expected: FAIL (no `scoreAgainst`, 1.0 s still `print: null`)

- [ ] **Step 3: Implement `scoreAgainst` and set `MIN_SECONDS` to 1**

Use `scoreAgainst` everywhere `best(...) >= MATCH` is used for people and guests.

- [ ] **Step 4: Re-run the test file**

Expected: PASS, including existing Maya/patient/guest tests

---

### Task 2: Publish the speaker before Whisper

**Files:**
- Modify: `portal/server/calendar.ts` (`hear`, add `noteSpeaker`)
- Modify: `portal/server/calendar-routes.ts` (`POST /api/audio`)
- Modify: `shared/calendar.ts` (`HeardSpeaker` gains optional `blurb?: string`)
- Test: `portal/server/calendar.test.ts`

**Interfaces:**
- Consumes: `cal.hear(text, speaker, now)`
- Produces: `cal.noteSpeaker(speaker: string, now?: Date): void` — sets `lastHeard` to `{ text: lastHeard?.text ?? '', note: '', speaker, at }` and `notify()`, without waiting on `handle`

- [ ] **Step 1: Write the failing test**

`noteSpeaker('Maya')` then `glassesState().heard.speaker` is Maya with relation granddaughter. A later `hear('hello', 'Maya')` fills `text` and keeps the speaker.

- [ ] **Step 2: Run that test**

Expected: FAIL (`noteSpeaker` missing)

- [ ] **Step 3: Implement `noteSpeaker` and call it in `POST /api/audio` as soon as `speakerOf()` returns, before `await transcribing`**

Keep `identify` starting immediately (already does). `speakerOf()` runs after `prepare` (sync embed). Then await Whisper, then `hear`.

- [ ] **Step 4: Run `node --test --test-name-pattern="noteSpeaker|straight away" portal/server/calendar.test.ts`**

Expected: PASS

---

### Task 3: `POST /api/audio/who` and person card from blurb

**Files:**
- Modify: `portal/server/calendar-routes.ts` or `portal/vite.config.ts` (whichever already owns `/api/audio`)
- Modify: `portal/server/voices.ts` (`cardFor` cooldown, fact source)
- Modify: `portal/src/api.ts`, `portal/src/operations.ts`
- Test: `portal/server/voices.test.ts`

**Interfaces:**
- Consumes: `voices.prepare`, `voices.assign`, `cal.noteSpeaker`
- Produces: `POST /api/audio/who` body = WAV, reply `{ match: Heard }` — no `hear()`, no transcript, no guest-ready iMessage

- [ ] **Step 1: Write the failing tests**

Person card fact is the first sentence of `blurb` even with no Groq fact. Card may show again 60 s after the last card, not 15 minutes. A helper `isWhoOnly` or route test is not required if voices tests cover card timing.

- [ ] **Step 2: Run the card tests**

Expected: FAIL (still 15 min / Groq-or-blurb already works — change `CARD_AGAIN_MS` to 60_000; test the new value)

- [ ] **Step 3: Wire `POST /api/audio/who`**: identify, `noteSpeaker`, return match. Defer `voices.json` / guest clip writes with `setImmediate` after `json(res, …)`.

- [ ] **Step 4: Run voices tests + `npm run typecheck`**

Expected: PASS

---

### Task 4: Glasses send a who-prefix and poll faster

**Files:**
- Modify: `src/audio/pipeline.ts`, `src/audio/segmenter.ts` (or a small hook on the pipeline)
- Modify: `src/main.ts` (`POLL_MS`, `postWho`)
- Modify: `src/api.ts`
- Modify: `src/screens.ts` (`heardBlock` shows blurb when `text` is empty)
- Test: `src/audio/pipeline` or new `src/audio/pipeline.test.ts`, `src/screens.test.ts`

**Interfaces:**
- Consumes: `POST /api/audio/who`
- Produces: pipeline option `onPartial?: (wav: Uint8Array) => void` fired once when speech has lasted 1200 ms; `POLL_MS = 250` while `mic === 'on'`

- [ ] **Step 1: Write the failing tests**

Segmenter/pipeline: after 1.2 s of loud frames, `onPartial` fires once; after silence, `send` fires with the full utterance. `heardBlock` with speaker Maya and empty text includes `Maya, your granddaughter:` and a blurb line when `speaker.blurb` is set.

- [ ] **Step 2: Run those tests**

Expected: FAIL

- [ ] **Step 3: Implement partial who + faster poll + empty-text heard lines**

Do not stop the mic on who. Full `/api/audio` still runs on utterance end.

- [ ] **Step 4: Run `node --test src/screens.test.ts src/audio/*.test.ts` and `npm run typecheck`**

Expected: PASS

---

### Task 5: Portal enrollment — second clip, re-record, live who

**Files:**
- Modify: `portal/index.html` (people section)
- Modify: `portal/src/main.ts` (save / re-record / test match)
- Modify: `portal/src/live-audio.ts` or `portal/src/api.ts` (`postWho`)
- Modify: `portal/server/voices.ts` (`enrollPrints` already windows a clip; sync must merge a new file)

**Interfaces:**
- Consumes: `POST /api/audio/who`
- Produces: UI actions: **Re-record** on a saved person (uploads new `voiceFile`, `sync()` rebuilds prints); **Test match** records ~2 s and shows `match.speaker` + score without calling `/api/audio`

- [ ] **Step 1: Write a small failing unit test if save/sync is pure enough; otherwise a voices test that a second `voiceFile` on the same id replaces prints after `sync()`**

Existing sync already rebuilds when `voiceFile` changes. Add a test that changing `p.voiceFile` and `sync()` recognizes the new level, not the old.

- [ ] **Step 2: Run it**

Expected: FAIL or already pass — if pass, keep it as the lock.

- [ ] **Step 3: Add Re-record + Test match in the people card. Test match uses who, not live-listen `/api/audio`.**

- [ ] **Step 4: Typecheck. Manually: portal People section records, Test match names the speaker.**

---

### Task 6: Guests are lazy; no disk on the hot path

**Files:**
- Modify: `portal/server/voices.ts` (`hearGuest`, `assign`, `save`)
- Test: `portal/server/voices.test.ts`

**Interfaces:**
- Produces: first unmatched clip returns `{ kind: 'unknown' }` (no new guest). Second clip of that same unmatched print (≥ MATCH to the pending print) creates the guest. `save()` is not required to complete before `assign` returns.

- [ ] **Step 1: Write the failing test**

One 3 s unknown → `kind: 'unknown'`, `guests().length === 0`. Second 3 s of the same fake voice → `Guest 1`.

- [ ] **Step 2: Run it**

Expected: FAIL (today the first clip is already Guest 1)

- [ ] **Step 3: Implement pending-unmatched, then guest. Keep `save` off the return path (`queueMicrotask` / `setImmediate`).**

- [ ] **Step 4: Run all `portal/server/voices.test.ts` tests**

Expected: PASS (update the old “unknown voices become numbered guests” test to the two-clip rule)

---

## Self-review

- Spec “who before words” → Tasks 2–4
- Spec “stored blurb first” → Tasks 3–4
- Spec “enrollment + re-record + live test” → Task 5
- Spec “better matching” → Tasks 1 and 6
- Spec “do not block on Groq” → Tasks 2–3
- Honest latency: 1.2 s of speech + embed + 250 ms poll ≈ 0.3–0.5 s after enough audio, not after they finish talking
