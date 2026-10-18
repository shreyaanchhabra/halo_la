# Make HALO Better — Roadmap

> **For agentic workers:** This is a ranked set of independent slices, not one feature. Do not implement the whole file. The user picks a slice; then write a focused TDD plan for that slice only (or execute it if they say so).

**Goal:** Make the 3-minute demo unforgettable, and stop the live product from failing the way it has tonight (wrong name, late name, calendar only for one voice, Groq dying, black screen).

**Architecture:** Keep local TitaNet for who, Groq only for words and plans, the care portal as the source of people. Improve the path that already exists; do not add a new vendor.

**Tech Stack:** TypeScript, sherpa-onnx, Groq Whisper + gpt-oss, Even Hub glasses, Vite portal.

**Spec:** Running product plus `docs/superpowers/specs/2026-10-18-fast-voice-id-design.md`. Earlier unused wow-factor notes stay unused until a slice is chosen.

## What is already true

- Home is today’s events. OS menu: Today, Appointments, Medications, Family.
- Name + relation + blurb can show before Whisper, after ~0.8 s of speech.
- Unmatched speech is `Unknown`, not Guest N.
- Calendar attaches a saved speaker to the plan when the voice is known.
- Matching requires a margin so a weak clip is not labeled Shreyaan.
- Click while paused resumes; it no longer kills the page.

## What is still weak (evidence)

1. **Every enrolled clip is a laptop `.webm`.** Dhruv, Aksh, Shreyaan were recorded in the browser. The glasses mic is a different channel. Shreyaan matches because that print happens to be close enough; the others often do not.
2. **Neo has no patient voice.** The wearer can never see `You:`.
3. **Aksh has no saved transcript** of the enrollment passage — likely a short or unused clip.
4. **Plan detection still calls Groq on every sentence that contains a time.** That is slow and dies on the 200k token/day 120b limit. Recent-fact calls burn the same quota.
5. **The judge-becomes-a-stranger demo was designed and never built.**
6. **The glasses page is one-shot.** A reload or old exit path still goes black until the simulator/app is restarted.
7. **Stale plans** (`needs_approval`, declined dinners) sit in data and confuse “today.”

## Global Constraints

- Do not commit `portal/.env`, `portal/data/`, or `portal/models/`.
- Do not add a cloud speaker-ID API.
- Groq keys stay in `portal/.env` only.
- Prefer one slice that a judge can see in 30 seconds over three invisible refactors.

## Review Focus (when a slice is built)

- A laptop-enrolled voice must still match after a glasses-mic clip is folded in.
- A time-less sentence must not call the plan model.
- Demo mode must not write fake people into the real care record unless that is the point and they can be cleared.
- Faster silence cut must not split “Saturday at two” across two clips.

---

## Slice A — Demo that judges remember (highest wow)

**Why:** Three minutes. Reviewers said the product is solid and forgettable.

**Do:**
- A portal **Demo** toggle: next unrecognized voice is treated as a new person the family just “added” live, *or* a scripted flow: judge speaks → Unknown → family names them in 10 s on the phone/portal → glasses show `Alex, your grandson:` and a line of blurb.
- A **mirror page** (`/demo` or patient page full-screen) that copies the glasses 576×288 so a room can see it.
- A 90-second spoken script on a card in the portal: one plan, one pill question, one “who is this.”

**Files (when built):** `portal/index.html`, `portal/src/main.ts`, new `portal/src/demo.ts`, `src/screens.ts` only if a “first meeting” card needs copy.

**Done when:** A stranger talks, is named once, and the glasses show name + relation before the sentence ends. The room can see it without peering at the glasses.

## Slice B — Stop Groq from killing the demo

**Why:** Calendar and facts share `gpt-oss-120b` and its 200k TPD. Listening in a room empties it.

**Do:**
- Default plan detection to `openai/gpt-oss-20b` (already the fallback). Keep 120b only if 20b is down.
- Do not call `refreshFact` at all unless `HALO_FACTS=1`.
- Skip `extractPlan`’s model call when `findWhen` is empty (already true) **and** when the line is under 8 words with no weekday/time token after a cheap regex, even if chrono misfires.
- Portal banner when the last plan call was a 429: “Calendar listening paused — quota.”

**Files:** `portal/server/groq.ts`, `portal/server/extract.ts`, `portal/server/voices.ts` (`scheduleFact`), `portal/src/main.ts`.

**Done when:** A 10-minute noisy listen still proposes “dinner tomorrow at 6.”

## Slice C — Enroll on the same mic that identifies

**Why:** This is the real reason only Shreyaan calendars cleanly.

**Do:**
- In the people card, **Record from glasses** (or “Use last heard clip”): the next `/api/audio` WAV for that person is folded into their print (already supported by sync merge / learned prints).
- Require **Test match on the glasses** (not only the laptop) before tagging `voice learned`.
- Record **Neo’s** voice the same way.
- Prompt two sentences, not one, so enrollPrints gets more windows.

**Files:** `portal/src/main.ts`, `portal/index.html`, `portal/server/voices.ts` (explicit `learnFromWav(personId, wav)`), `portal/server/calendar-routes.ts`.

**Done when:** Aksh and Dhruv each say one line on the glasses and Test match (glasses) names them three times in a row.

## Slice D — Calendar that does not wait on a personality

**Why:** Accuracy is tied to who Whisper heard and who the model thinks “I” is.

**Do:**
- Keep `withKnownSpeaker` (already in). Add the same for the **patient** when the wearer says “I have dentist Tuesday at 9” (`You` / Neo).
- If speaker is unknown, **do not** invent a who from recent context (stops Shreyaan-sticky plans).
- Show the proposed card with the speaker line already filled: `Aksh: dinner · Tomorrow 6 PM`.
- Cheap yes/no: if the wearer says only “yes” / “no” within the window, do not send that clip to the planner (already true via `parseAnswer`). Make sure the who-prefix cannot overwrite an open prompt.

**Files:** `portal/server/extract.ts`, `portal/server/calendar.ts`, `src/screens.ts`.

**Done when:** Aksh and Shreyaan each propose a different plan in one session; each card shows the right name; “yes” confirms the open one only.

## Slice E — Less lag, without cutting words in half

**Why:** 450 ms silence + 800 ms who is better; mid-sentence cuts would make calendar worse.

**Do:**
- Who-prefix at **600 ms** only if RMS has been above sustain for that whole window (not a cough).
- End silence **400 ms** after a time-word has already been heard in this utterance (needs a tiny on-device digit/`o'clock`/`tomorrow` check, or keep 450).
- Poll **200 ms** only while `heard.text` is empty or a who is in flight; 500 ms otherwise (less draw flicker).
- Log `who_ms` and `words_ms` on `/api/audio/stats` so we stop guessing.

**Files:** `src/audio/segmenter.ts`, `src/audio/pipeline.ts`, `src/main.ts`, `portal/server/calendar-routes.ts`.

**Done when:** Name on glasses < 400 ms after 0.6 s of a known voice; “Saturday at 2” stays one clip.

## Slice F — Housekeeping the judges should never see

- Record Neo. Re-record Aksh until Test match works.
- Delete stale `needs_approval` / declined demo dinners from `/api/plans`.
- Pause live listen in the portal during glasses demo (two mics steal Groq).
- Do not open the OS menu during the spoken demo (FOREGROUND events used to stop the mic; it is fixed, still a time sink).

---

## Suggested order for this weekend

1. **C then D** if the goal is “any teammate can walk up and get a plan.”
2. **B then A** if the goal is “survive the room and have a wow.”
3. **E** only after C — faster waits on a bad print just flash Unknown sooner.

## What this file is not

A license to build all six slices. Pick one. The next message should name the letter.
