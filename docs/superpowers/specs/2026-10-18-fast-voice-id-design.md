# Fast voice ID: name and description on the glasses

## Intent

When someone near the patient starts talking, the glasses should already show **who they are** and **how they relate to the patient**, from a voice sample saved in the care portal. Words and calendar plans can arrive a moment later. Today those three things wait on the same slow path, so the wearer sees a stranger, then a Guest number, then the name.

## Why it fails now

1. **Identity waits for Whisper.** `/api/audio` embeds the clip in parallel with transcription, but the glasses only get a speaker after the transcript exists. Whisper is 0.4–1 s when Groq is healthy, and much longer when it is not.
2. **The glasses look once a second.** Even a 50 ms match sits behind a 1000 ms poll.
3. **The wearer waits for a full pause.** The mic waits 700 ms of silence before sending anything, so the earliest identity is after they have already stopped talking.
4. **The “description” is a Groq sentence.** The person card’s fact is generated 20 s later by `gpt-oss-120b`. The family’s own one-line blurb is already on the person and is what should appear first.
5. **Matching is brittle across mics.** One browser recording is compared to the glasses mic. Clips under 1.5 s are thrown away (then credited to whoever last spoke). Every unmatched voice becomes a new Guest and is written to disk on the request.
6. **Enrollment already exists** under “People HALO should recognize” (name, relation, about-them, one read-aloud clip). People still fail to match because one sample from a laptop mic is a poor print for the glasses, and there is no re-record or instant “did this match?” check that skips Whisper.

True milliseconds over HTTP + TitaNet + a poll is not possible. The target is: **name, relation, and the family’s line on the glasses about 300–500 ms after 1.2 s of speech**, while they are still talking. Words follow when Whisper finishes.

## Goals

- Show name + relation + stored blurb as soon as the voiceprint matches, without Whisper or Groq.
- Let the family enroll people in the care portal with a relation, a short description, and short clips, then re-record until a live test matches.
- Recognize enrolled people more reliably on the glasses mic, including short replies after someone has just spoken.
- Keep calendar detection and transcription on the existing path; they must not block the name.

## Non-goals

- A new cloud speaker-ID vendor. Stay on local sherpa-onnx / TitaNet.
- Diarizing two people talking over each other.
- Replacing Whisper or Groq for words and plans.
- Changing the glasses font or layout language.

## Anti-goals

- Showing “Guest 12” on the glasses for someone the family already enrolled.
- Holding the spoken line until Groq has a clever fact.
- Creating a second people database besides the care record.

## How it works

### Care portal (already the source of truth)

Each person in `HaloData.people` has `name`, `relation`, `blurb`, and `voiceFile`. The patient has their own sample. That stays.

Changes:

- Saving a person still requires a clip. After save, a **Test match** on this computer talks to `/api/audio/who` (voiceprint only) and shows the name and score in under a second.
- An existing person can **re-record**. A second clip is stored and folded into the same voiceprint (more 3 s windows).
- Unrecognized guests stay as a way to name a stranger after the fact; they are no longer created on the first unmatched sentence.

### Matching (local)

Keep TitaNet embeddings and cosine similarity.

- Score is the better of **max** over saved prints and **cosine to their centroid**. Centroid is more stable when the glasses mic differs from the laptop mic.
- Identify from **1.0 s** of audio (today 1.5 s). Short “yes” still inherits the last speaker for 10 s.
- Adaptive learning of glasses-mic prints on confident matches stays.
- Guest creation waits until the same unmatched voice has been heard twice. Disk writes for guests and `voices.json` happen after the HTTP response, not before.

### Two server moments for one sentence

1. **Who (fast).** `POST /api/audio/who` with a 16 kHz WAV. Embed, assign, set `glassesState.heard` to `{ text: '', note: '', speaker }` if there is not already newer text for this utterance, and expose `GlassesView.person` immediately using `name`, `relation`, and `blurb` (first sentence, no Groq). Returns in tens to low hundreds of milliseconds.
2. **Words (existing).** `POST /api/audio` still transcribes and runs calendar `hear()`. It must **assign the speaker before awaiting Whisper**, publish that speaker to glasses state at once, then fill in `text` when Whisper returns.

`hear()` already publishes the transcript before the plan check. Who-before-words is the same idea one step earlier.

### Glasses

- After **1.2 s of continuous speech**, send that prefix to `/api/audio/who` once per utterance. When the utterance ends, send the full clip to `/api/audio` as today.
- Poll glasses state every **250 ms** while the mic is on (1000 ms when paused).
- Home screen: if `heard.text` is empty but `heard.speaker` is known, show the speaker line and the blurb (or relation) until the words arrive.
- Person card: show on a new recognized person using the stored blurb. Cooldown 60 s, not 15 minutes. Groq facts may replace the blurb later if they arrive.

## Success

A family member enrolled in the portal walks up and starts talking. Within about a second of speech the glasses show their name, “your …”, and the family’s line. The spoken sentence appears under that shortly after. A live test in the portal names them without waiting for a transcript. Calendar questions still appear after the words, not instead of the name.
