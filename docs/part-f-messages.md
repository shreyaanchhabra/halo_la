# Part F: messages from approved contacts

Implemented in the existing HALO TypeScript server, G2 app and family portal.

## Try it

Run `npm run portal` (care portal and backend, port 5176) and `npm run dev` (glasses app, port 5175). Restart the portal after changing backend code.

Open `http://localhost:5176/messages.html` for family messaging. The glasses app at `http://localhost:5175/` needs the Even App or simulator; a regular browser does not provide the G2 bridge.

1. Add a caregiver's international phone number and approve it in Family Messages.
2. Have them text the Photon agent number shown on the page once to connect.
3. Messages from approved contacts appear in the family inbox and on the glasses. Unapproved texts stay in the portal inbox only; approving later does not release an old message.
4. On the glasses, hold to start a voice reply. HALO transcribes it and displays the exact text for review. Tap through every page and confirm to send; hold during review to cancel.
5. For a no-provider test, use the demo controls. Synthetic demo replies are recorded locally and never sent, even when a live provider is configured.

Tap turns message pages; the final tap dismisses an incoming message. Double-tap still pauses listening on Today. The microphone and speaker identification are active only on Today; opening Appointments, Medications, or Family stops listening until returning to Today. Calendar confirmations and reminders have priority over messaging. G2 has no speaker: reply review is visual, with no claim of spoken readback.

## Behavior

- Approval is explicit and separate from voice enrollment. Phone numbers require an international country code.
- Photon polls direct iMessages every few seconds. Provider IDs are deduplicated across retries.
- Unknown senders' messages remain in the family portal inbox but do not reach the glasses or receive an automatic HALO reply. Approval does not make earlier withheld messages available; the sender must text again.
- Revocation immediately removes pending messages and cancels reply drafts. Reapproval does not resurrect them. A send already accepted by the provider cannot be recalled.
- Caregiver replies are drafted from speech, shown for review, and sent only after exact confirmation. Photon uses an idempotency key. A provider-accepted message may still fail delivery; HALO does not claim a read receipt.
- HALO continues to answer caregiver questions and supported actions over iMessage. Ordinary family-to-patient updates are delivered to the glasses without generating a spurious AI response.
- Caregivers can pause care updates by text. HALO sends a dose update to active, approved contacts after a dose is marked taken or undone, and retains the missed-dose safety alert. Refill and price updates are sent when those results are ready; scheduled appointment reminders and morning check-ins are off. A caregiver can text "summary" any time for today's dose status and upcoming appointments.
- Photon replies and proactive care texts appear in Family Messages alongside incoming texts and reviewed glasses replies. Data and source-linked activity are persisted in `portal/data/family-messages.json`, or the file named by `HALO_MESSAGES_FILE`. This remains the project's single-process demo architecture.

## Photon configuration and alternate adapter

Set `PHOTON_PROJECT_ID`, `PHOTON_API_KEY` and `PHOTON_AGENT_NUMBER` in `portal/.env`, then restart the portal. The Family Messages page shows connection health and the agent number; secrets remain server-side.

For development or another provider, `HALO_MESSAGE_SEND_URL` and the authenticated `POST /api/messages/incoming` webhook remain available when Photon is not configured. An alternate bridge must verify its provider's webhook signature and bind events to the correct patient before forwarding. Provider acceptance is not a delivery receipt.

This portal retains its existing unauthenticated hackathon architecture. Do not expose it as a real patient service without patient-scoped authentication, family-only authorization, encryption at rest and a verified provider integration.

## Verification

`node --test portal/server/messages.test.ts portal/server/message-routes.test.ts portal/server/proactive.test.ts portal/server/photon.test.ts src/message-screen.test.ts` checks approval, revocation, webhook and provider deduplication, review-before-send, care-summary content, caregiver intent routing and message pagination. HTTP tests require localhost access. Voice input requires the existing Groq configuration and a microphone; physical ring/temple behavior needs a G2 hardware test.
