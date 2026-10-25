# HALO LA

HALO is a prototype care assistant for people living with dementia and the families who support them. It connects **Even Realities G2 smart glasses** to a **caregiver web portal**, helping the wearer remember people, keep track of plans and medicines, and stay in touch with approved family contacts.

The glasses present short text prompts and accept speech and touch input. The portal handles setup, prescription review, calendars, pill counts, refill approvals, and family messages. A separate patient page offers a browser-based view of the day's care information.

This repository is a local, single-patient demo. Its backend runs inside the portal's Vite development server and saves state to local files. It is not a production patient service.

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Using HALO](#using-halo)
- [Development commands](#development-commands)
- [Repository layout](#repository-layout)
- [API overview](#api-overview)
- [Data and external services](#data-and-external-services)
- [Verification](#verification)
- [Troubleshooting](#troubleshooting)
- [Current limitations](#current-limitations)

## Features

### Plans from conversation

HALO segments microphone audio into utterances, transcribes speech, and looks for plans such as “I'll come Saturday at two.” It presents a proposed calendar entry for a spoken yes or no. Unanswered proposals move to the family portal for approval instead of being silently confirmed.

Family members can also add, edit, approve, reject, and delete plans through the calendar. An iCalendar feed includes medication schedules, appointments, and plans.

### Medication reminders and dose tracking

- Upload a prescription as a PDF or image and extract medicines, instructions, and follow-up appointments for review.
- Edit medicine details and scheduled dose times in the portal.
- Show due-dose prompts on the glasses and record spoken confirmations.
- Mark doses taken or undo them through the web interfaces.
- Track remaining supply from a family-entered pill count and subsequent logged doses.

A dose log records a user's confirmation; it does not verify that medicine was physically taken. Prescription extraction can make mistakes and needs human review.

### Refill assistance

When supply reaches seven days remaining, HALO can use Browser Use to look up nearby GoodRx coupon prices. Family members review the result and approve a pickup reminder within a configurable spending limit.

HALO **does not order medicine or process payments**. Approval creates a calendar reminder. Marking the refill received updates the pill count once. Price quotes expire after six hours; the default approval limit is $25. A lookup has a $1 Browser Use cost cap and an eight-minute wait timeout.

See [the refill workflow](docs/refills.md) for approval rules and lifecycle details.

### Recognizing people by voice

The portal lets families record the patient and familiar people, including each person's name, relationship, and background information. Speaker embeddings are computed locally with sherpa-onnx and NVIDIA's TitaNet-Large model. Recognized speakers can appear as short identity cards on the glasses.

Unknown voices can be reviewed and named in the portal. Speaker recognition is probabilistic and is not an authentication mechanism. G2 identification uses audio, not a camera.

### Family messages and care updates

- Explicitly approve contacts who may send messages to the glasses.
- Receive direct iMessages through Photon and review conversations in the family inbox.
- Dictate a reply, review its exact text on the glasses, and confirm before sending.
- Keep unapproved incoming messages in the portal without delivering them to the wearer.
- Send supported care updates, including dose changes, missed-dose alerts, and refill or price results, to active approved caregivers.
- Let caregivers request a care summary or use supported actions over iMessage.
- Exercise messaging locally with demo controls when no provider is configured.

Contact approval is separate from voice enrollment. Revocation removes pending messages and reply drafts. Provider acceptance is not a delivery or read receipt. Scheduled appointment texts and morning check-ins are currently disabled.

See [family messaging](docs/part-f-messages.md) for provider setup, review-before-send behavior, and the alternate transport.

## Architecture

```text
G2 glasses / Even App / simulator
    |
    | microphone audio, touch events, text display
    v
Glasses frontend: src/                         localhost:5175
    |
    | /api requests proxied by Vite
    v
Care portal + backend: portal/                localhost:5176
    |-- Care setup, calendar, messages, and patient web pages
    |-- Calendar, medication, refill, and message services
    |-- Local speaker recognition with sherpa-onnx
    |-- JSON state and uploaded files in portal/data/
    |
    |-- Groq: speech transcription and AI extraction
    |-- Browser Use: GoodRx price lookup
    |-- Photon: iMessage integration
    `-- Sentry: optional error reporting and tracing
```

Both frontends use TypeScript and Vite. The web portal uses HTML, CSS, and DOM-based UI code. Shared types and formatting utilities live in `shared/`.

The backend is a Vite plugin in `portal/vite.config.ts`, using `configureServer` middleware. There is no separately packaged production API server. The glasses poll backend state; portal pages receive data-change notifications through Vite's WebSocket connection.

## Requirements

- **Node.js 24 LTS recommended** and npm. The test command runs TypeScript directly through Node's built-in test runner.
- **Even Realities G2 glasses with the Even App**, or the included simulator tooling, for the glasses interface. `app.json` declares minimum Even App version `2.2.10` and SDK version `0.0.16`.
- A browser with microphone permission for web-based recording and live listening. Browser microphone capture requires a secure context, such as localhost or HTTPS.
- **Groq API access** for transcription, prescription reading, and AI-driven conversation processing.
- **FFmpeg on `PATH`** for decoding non-WAV voice-enrollment recordings.
- The downloaded **TitaNet voice model** for local speaker recognition.

Browser Use, Photon, and Sentry credentials enable their respective optional integrations. You can open the portal and explore manual workflows without configuring every service.

## Quick start

### 1. Install dependencies

From the repository root:

```sh
npm ci
```

For voice enrollment, install FFmpeg if it is not already available. On macOS with Homebrew:

```sh
brew install ffmpeg
```

Download the speaker-recognition model:

```sh
npm run voice-model
```

The model is approximately 100 MB and is saved to `portal/models/nemo_en_titanet_large.onnx`. It is excluded from Git.

### 2. Configure the portal

Create `portal/.env` with the integrations you want to use:

```dotenv
# Speech transcription, prescription reading, and conversation processing
GROQ_API_KEY=your_groq_api_key

# Optional: GoodRx lookups through Browser Use Cloud
BROWSER_USE_API_KEY=

# Optional: Photon iMessage integration; all three values are required
PHOTON_PROJECT_ID=
PHOTON_API_KEY=
PHOTON_AGENT_NUMBER=

# Optional: portal browser and backend observability
SENTRY_DSN=
```

Environment files are ignored by Git. Restart the portal after changing these values.

### 3. Start the portal and backend

In one terminal:

```sh
npm run portal
```

Open the relevant page:

- Care setup: <http://localhost:5176/>
- Calendar: <http://localhost:5176/calendar.html>
- Family messages: <http://localhost:5176/messages.html>
- Patient page: <http://localhost:5176/patient.html>
- Calendar feed: <http://localhost:5176/api/calendar.ics>

The server creates `portal/data/` as needed. Add a patient name and ZIP code, enroll voices, and upload a sample prescription to begin.

### 4. Start the glasses frontend

In a second terminal, from the repository root:

```sh
npm run dev
```

The glasses frontend runs at `http://localhost:5175` and proxies `/api` to the portal. It requires the Even App bridge; opening it in a regular browser alone does not provide a functional glasses session.

For the simulator, use a third terminal:

```sh
npm run sim
```

For physical glasses, keep the phone and development machine on the same network and generate the development QR code:

```sh
npm run qr
```

Scan it using the Even App. The QR command is macOS-specific and uses the IP address of the `en0` network interface. If your active interface differs, use its address with the Even Hub CLI instead. The glasses Vite server listens on the LAN; the portal can remain on localhost because requests travel through the glasses server's proxy.

## Configuration

### Portal integration settings

These values are read from `portal/.env` by `portal/vite.config.ts`:

- `GROQ_API_KEY`: enables cloud speech transcription and AI extraction.
- `BROWSER_USE_API_KEY`: enables pharmacy price lookups.
- `PHOTON_PROJECT_ID`, `PHOTON_API_KEY`, `PHOTON_AGENT_NUMBER`: enable the Photon adapter when all three are supplied.
- `SENTRY_DSN`: enables portal/backend Sentry reporting. `VITE_SENTRY_DSN` is accepted as a fallback.

### Glasses API routing

- `HALO_PORTAL`: shell environment override for the development proxy target; defaults to `http://localhost:5176`.
- `VITE_HALO_API`: build-time API base URL for the glasses frontend. Leave unset for same-origin development requests. For a packaged app, set it to a backend address reachable by the device.

Example development proxy override:

```sh
HALO_PORTAL=http://localhost:5176 npm run dev
```

Packaged builds also need a matching network whitelist in `app.json`. The current manifest lists `http://localhost:5176`; changing only the frontend API URL is insufficient for another backend address.

### Advanced server settings

The following are read directly from `process.env`. Export them in the shell that starts the portal rather than relying on `portal/.env`:

- `HALO_ANSWER_WINDOW_MS`: overrides the spoken calendar-confirmation window; the default is 60 seconds.
- `HALO_MESSAGES_FILE`: overrides the family-message store path; defaults to `portal/data/family-messages.json`.
- `HALO_MESSAGE_SEND_URL`: enables the alternate outgoing message bridge when Photon is not configured.
- `HALO_MESSAGE_SEND_TOKEN`: optional bearer token for that outgoing bridge.
- `HALO_MESSAGE_WEBHOOK_TOKEN`: bearer token required for `POST /api/messages/incoming`.
- `HALO_DEBUG_INJECT`: enables the development audio-injection endpoint. Leave unset for ordinary use.

An alternate messaging bridge must validate its provider's webhook signature and associate events with the intended patient before forwarding them to HALO.

## Using HALO

### Set up a patient

1. Open the care setup page and enter the patient name and a five-digit ZIP code.
2. Record the patient's voice so HALO can distinguish them from visitors.
3. Add familiar people with their relationships, short background notes, and voice samples.
4. Upload a prescription from your own test data or `portal/samples/`.
5. Review extracted medicines, strengths, instructions, dose times, quantities, and appointments. Correct any errors.
6. Enter remaining pill counts and review the refill spending limit.

The sample PDFs and images are mock prescriptions for development.

### Test speech and scheduling

Use **Listen live** in the portal to exercise transcription and speaker matching without wearing the glasses. Live speech is added to the conversation and can produce proposed plans. **Test match** checks recognition without adding the sentence to the calendar.

On the glasses' Today screen, say a clear future plan and answer the resulting confirmation prompt. The patient page and care portal show pending questions and upcoming events. If a question expires, review it in the care portal.

### Navigate the glasses

- **Today** shows current events and contextual prompts.
- **Tap, then hold** opens the glasses menu with Today, Appointments, Medications, and Family.
- **Swipe on a menu page** moves through its content; a press returns home.
- **Double-tap on Today** pauses or resumes listening.
- **Medication prompts** request a spoken answer such as “taken” or “not taken.”
- **Incoming messages** can be paged through and dismissed by tapping.
- **Hold while replying** starts voice reply capture. Review every page of the transcription and confirm to send; hold during review to cancel.

Conversation listening and speaker identification run on Today when listening is enabled. Opening a detail page stops listening until returning home. Calendar questions, reminders, and care cards take priority over family messaging. G2 has no speaker; reply review is visual.

### Connect family messaging

1. Configure Photon and restart the portal.
2. Open Family messages and add a caregiver's international phone number.
3. Explicitly approve that contact.
4. Have the caregiver text the displayed Photon agent number once to connect.
5. Send a new message and review it on the glasses.

Previously withheld messages are not released when a contact is approved; the sender must send again. Without a live provider, use the demo controls. Synthetic demo replies remain local even when a provider is configured.

### Review a refill

Set a medicine's stock so its supply is at or below seven days. With a ZIP code and Browser Use key configured, HALO looks up prices and presents a result for family review. Approval requires a name, the expected price, a fresh quote, and a price within the limit. It creates a pickup reminder for tomorrow at 10:00; adjust it in the calendar as needed.

After collection, mark the refill received to add the priced quantity to stock. Failed or rejected lookups wait for a person to request another attempt rather than repeatedly spending API credits.

## Development commands

Run these from the repository root:

```sh
npm run dev          # Glasses Vite server on port 5175
npm run portal       # Web portal and development API on port 5176
npm run sim          # Simulator pointed at the glasses dev server
npm run qr           # Generate a LAN development QR code (macOS/en0)
npm run voice-model  # Download the local speaker-recognition model
npm run typecheck    # Check glasses, portal, and server TypeScript
npm test             # Run TypeScript tests with Node's test runner
npm run build        # Type-check and build the glasses frontend into dist/
npm run preview      # Preview the built glasses frontend
npm run pack         # Build and package dist/ with app.json via Even Hub CLI
```

`build` and `pack` target the glasses app. `preview` serves built frontend assets; it does not start the portal backend or reproduce the glasses development server's API proxy. This repository does not include a production portal deployment command.

## Repository layout

```text
app.json                 Even Hub manifest, permissions, and network whitelist
index.html               Glasses frontend entry page
vite.config.ts           Glasses dev server and API proxy
src/
  main.ts                Even App bridge, lifecycle, polling, display, and input
  screens.ts             Text layouts and glasses menu pages
  messaging.ts           Incoming-message and reviewed-reply interaction
  api.ts                 Glasses API client
  audio/                 Segmentation, resampling, pipeline, and WAV encoding
portal/
  index.html             Caregiver setup page
  patient.html           Patient browser interface
  calendar.html          Calendar interface
  messages.html          Family inbox and contact approval
  vite.config.ts         Backend middleware, integrations, and persistence
  src/                   Portal UI, API clients, scheduling, and medicine logic
  server/                Calendar, voices, refills, messaging, AI, and telemetry
  samples/               Mock prescriptions
  data/                  Runtime patient data and uploads (ignored by Git)
  models/                Downloaded speaker model (ignored by Git)
shared/                  Calendar/message/refill types and formatting utilities
docs/                    Product pitch, feature notes, designs, and plans
```

Tests sit beside the modules they cover as `*.test.ts` files.

## API overview

All development APIs are served by the portal under `/api`. These are internal demo endpoints, not a stable public API. Read the route modules for request and response types.

- **Care data and uploads:** `GET/PUT /api/data`, `POST /api/upload`, `GET/DELETE /api/files/:file`, `POST /api/read-prescription`, and `POST /api/transcribe`.
- **Doses:** `GET/POST /api/doses`; a dose is identified by `medKey` and a `YYYY-MM-DD HH:MM` slot. Posting `taken: false` undoes a taken mark.
- **Speech:** `POST /api/audio`, `/api/audio/who`, and `/api/audio/dose` accept audio for conversation processing, identification, and dose answers. Conversation audio is a 16 kHz mono WAV.
- **Transcripts and plans:** `GET/POST /api/transcripts`, `GET/POST /api/plans`, `PATCH/DELETE /api/plans/:id`, and `POST /api/plans/:id/{approve,reject,yes,no}`.
- **Calendar export:** `GET /api/calendar.ics`.
- **Glasses state:** `GET /api/glasses`, `/api/glasses/state`, and `/api/glasses/menu`; `POST /api/glasses/seen` acknowledges a care card.
- **Voice review:** `GET /api/voices`, `GET /api/voices/guests/:id/clip`, `POST /api/voices/guests/:id/name`, and `DELETE /api/voices/guests/:id`.
- **Prices and refills:** `GET/POST/DELETE /api/prices`, `GET /api/refills`, `PUT /api/refills/settings`, `POST /api/refills/check`, and `POST /api/refills/:id/{approve,reject,requote,received}`.
- **Family messaging:** `GET /api/messages`, `GET /api/messages/state`, `POST /api/messages/contacts`, `/api/messages/demo`, and `/api/messages/incoming`; per-message actions use `POST /api/messages/:id/{dismiss,draft,audio,confirm,cancel}`.
- **Diagnostics:** `GET /api/imessage` and `GET/POST /api/audio/stats`.

## Data and external services

Runtime state is written under `portal/data/`, including:

- `halo.json`: patient details, people, prescriptions, and stock data.
- `plans.json` and `transcripts.json`: calendar state and stored conversation lines.
- `doses.json`, `prices.json`, and `refills.json`: dose history, price results, and refill state.
- `voices.json`: voiceprints and recognition metadata.
- `glasses.json`: care-card state.
- `imessage.json`, `messages.json`, and `family-messages.json`: Photon and family-message state.
- `uploads/`: uploaded prescriptions and recordings.
- `voice-clips/`: temporary unknown-speaker clips; guest review state is cleared when the voice service starts.

These files, environment files, downloaded models, and generated Even Hub packages are ignored by Git. Stop the portal before copying `portal/data/` for a consistent local backup. Treat copies as sensitive data; local JSON and uploads are not encrypted by this app.

Data processing crosses several boundaries:

- **Local:** speaker embedding and matching run on the machine hosting the portal.
- **Groq:** speech clips are sent for transcription; prescription text/images and relevant context are sent for AI processing. Local speaker recognition does not mean the entire audio workflow stays on-device.
- **Browser Use / GoodRx:** medicine details and ZIP code are used for cloud browser price searches.
- **Photon:** messages and recipient phone numbers are handled by the messaging provider.
- **Sentry:** when configured, browser/backend errors and traces are reported externally.

## Verification

For code changes, run:

```sh
npm run typecheck
npm test
npm run build
```

Tests cover audio segmentation and resampling, screen layouts and inputs, message review, speaker matching, plan extraction and approval, scheduling, dose/supply calculations, refill rules, provider behavior, and HTTP routes. Integration boundaries are mocked in many tests; passing the suite does not establish that live provider credentials or physical glasses work.

HTTP tests require permission to bind localhost ports. A complete manual check also exercises real microphone input, voice enrollment, a calendar confirmation, a dose confirmation, and a reviewed message reply. Verify temple/ring gestures on physical hardware when changing those interactions.

For audio debugging, open the glasses frontend with `?debug` to show mic statistics. Development injection uses `?debug&mic=injected` together with the server's `HALO_DEBUG_INJECT` setting; it bypasses the real microphone.

## Troubleshooting

### The glasses frontend waits or appears blank in a browser

The frontend waits for the Even App bridge. Use the Even App or simulator. To explore HALO without that bridge, open the portal or patient page on port 5176.

### API requests fail or the glasses show offline

Keep both dev servers running. The glasses server on port 5175 proxies to port 5176 by default. Check `HALO_PORTAL` if the portal is elsewhere. For packaged builds, check `VITE_HALO_API`, device reachability, and the `app.json` whitelist together.

### The phone cannot open the development app

Check that the phone and computer share a network, that port 5175 is reachable, and that the QR code uses the computer's active LAN address. The bundled QR script assumes macOS interface `en0`.

### Speech or prescription reading reports a missing key

Set `GROQ_API_KEY` in `portal/.env` and restart the portal. Provider quotas and rate limits can also interrupt processing; inspect the portal terminal for the actual error.

### Speaker recognition is unavailable

Run `npm run voice-model`, check that FFmpeg is on `PATH`, and restart the portal. Confirm voice samples are saved and inspect `/api/voices` or the portal for model/enrollment errors. Native sherpa-onnx loading failures may depend on your Node version and platform.

### Browser recording does not start

Allow microphone access and use localhost or HTTPS. Plain HTTP on a LAN IP may not qualify as a secure browser context.

### No refill prices appear

Set a five-digit patient ZIP code, configure `BROWSER_USE_API_KEY`, and ensure the medicine has a quantity and tracked stock. Automatic lookup starts when a refill is due. Failed or rejected refills require an explicit retry; the service avoids repeated automatic paid lookups.

### Family messages do not reach the glasses

Check all three Photon settings, restart the portal, and inspect connection health in Family messages. Approve the sender's international phone number and have them text the agent number. Approval applies to new messages. Demo messages and replies do not send through the live provider.

### Backend edits do not take effect

Restart `npm run portal` after changing backend code or environment settings.

## Current limitations

- The portal has no patient-scoped sign-in or verified family/doctor roles. A typed approval name is not a verified identity.
- Local JSON persistence assumes one running server and one patient; there is no transactional database or multi-instance coordination.
- The development API and uploaded files need authentication and authorization before use as a real patient service. Data encryption, access controls, retention, and consent workflows require additional work.
- Cloud-dependent features need network access, credentials, and available provider quota.
- Speech transcription, prescription extraction, speaker matching, and plan interpretation can be wrong. Review consequential outputs.
- The glasses provide text output, not spoken readback. HALO does not diagnose, prescribe, verify ingestion, or purchase refills.
- The broader [product pitch](docs/halo-pitch.html) includes ideas beyond the implemented demo, such as a larger agent team and doctor reporting. Treat it as product direction, not a specification of shipped functionality.

Additional references: [refill workflow](docs/refills.md), [family messaging](docs/part-f-messages.md), and [voice identification design](docs/superpowers/specs/2026-10-18-fast-voice-id-design.md). Where older design documents differ from current behavior, use the code as the source of truth.
