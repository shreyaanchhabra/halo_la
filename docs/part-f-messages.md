# Part F: messages from approved contacts

Implemented in the existing HALO TypeScript server, G2 app and family portal.

## Try it

From the repository, run `npm run start:all`. This starts the backend, care portal and glasses app together, reuses healthy services, and restarts a managed service if it exits. Keep that launcher running. In Turnstone, the managed development server keeps it running beyond a chat turn. Restart the launcher after changing backend code.

Open http://localhost:5174/messages.html for the complete browser demo. The glasses app is at http://localhost:5175/ and needs the Even App or simulator; a regular browser alone does not supply the G2 bridge. Port 5173 is left free for other projects.

1. Add Maya, granddaughter, with the synthetic number `+12025550101`, and approve her.
2. Simulate “Running 10 min late!” from that number. The glasses show her name, relationship and text.
3. Simulate a message from `+12025550199`. It appears in the family inbox and never on the glasses.
4. On the glasses, hold to start a voice reply. Speak one short reply and pause. HALO transcribes it with the existing Groq speech integration and displays the exact text. Tap through all pages, then tap **send**. Hold during review to cancel.
5. With no glasses or microphone, use **Stage demo reply on glasses** in the portal, review each page with **Preview next page**, then click **Confirm demo reply**. The confirmation button is enabled only on the final page. You can also cancel a staged reply or dismiss a synthetic message using the demo controls.
6. The inbox marks the reply **Demo recorded, no text sent**. Synthetic demo messages never send a real text, including when a live adapter is configured.

The incoming number must match an approved contact exactly after normalization. Saving a contact now fills that number into the incoming demo form. A message from another number appears only in the family inbox; approving a different number will not release it.

Tap turns message pages; the final tap dismisses an incoming message. Double-tap still pauses listening. Calendar confirmations and reminders have priority over messaging. G2 has no speaker: reply review is visual, with no claim of spoken readback.

## Behavior

- Approval is an explicit messaging permission, separate from voice enrollment. Phone numbers require an international country code; formatting is normalized without guessing the country.
- Unknown senders are withheld, with their complete messages retained in the family inbox. Later approval does not release those old messages.
- Revocation immediately removes pending messages and cancels reply drafts. Reapproval does not resurrect them. An external send already in progress cannot be recalled.
- Repeated provider IDs are deduplicated. Reusing an ID with a different body/sender is rejected.
- Message/reply bodies are paginated into five-line screens. The wearer sees every page before the final send control. Drafts expire after two minutes. The server requires explicit confirmation and the exact reviewed text, rechecks approval, and locks a send before calling the adapter.
- Ambiguous delivery is marked **unknown**, never automatically retried. The original message is dismissed to prevent an accidental second reply. Family should check the provider before attempting any new send.
- Data and source-linked activity are persisted in `server/data/messages.json`, or the file named by `HALO_MESSAGES_FILE`. This is the project's existing single-process demo architecture.

## Live messaging adapter

Photon is not integrated or verified by this change. No phone inbox is read automatically. A phone/provider bridge must forward inbound texts and implement the following HALO-owned adapter contract.

Incoming: `POST /api/messages/incoming` with `Authorization: Bearer <HALO_MESSAGE_WEBHOOK_TOKEN>` and JSON `{ "providerId": "stable-provider-message-id", "from": "+12025550101", "text": "Running late" }`. Configure the webhook token in the server environment. Without it the live webhook returns 503; invalid authorization returns 401. The bridge must verify the provider's actual webhook signature and bind events to this patient before forwarding. Provider IDs must be stable across retries.

Outgoing: set `HALO_MESSAGE_SEND_URL` to an HTTPS adapter URL and optionally `HALO_MESSAGE_SEND_TOKEN`. HALO posts `{ "id": "reply-uuid", "to": "+12025550101", "text": "Reviewed reply" }`, sends the reply UUID as `Idempotency-Key`, and expects `{ "providerId": "accepted-provider-id" }` only after provider acceptance. The adapter must enforce that idempotency key. HTTP localhost adapters are allowed for development. Provider acceptance is not a delivery/read receipt.

The family endpoints and demo injection follow the existing unauthenticated hackathon portal. Keep this on a trusted development network with synthetic data. Patient-scoped authentication, family-only authorization, a doctor role that cannot access the inbox, encryption at rest and provider-specific integration remain prerequisites for real patient deployment.

## Verification

`node --test server/messages.test.ts server/message-routes.test.ts src/message-screen.test.ts` checks approved versus unknown senders, revocation, webhook authorization and duplicates, expiry, exact confirmation, cancellation, send concurrency, unknown delivery, demo isolation and complete message pagination. HTTP tests require localhost access. Voice input also requires the existing Groq configuration and a microphone; physical ring/temple behavior needs a G2 hardware test.

All 13 Flow F tests passed. Glasses and multi-page portal production builds passed, as did TypeScript checks for the app, server and portal. A broader test-suite run passed 134 of 135 tests; the calendar test for “Let's have dinner together tomorrow at 6” received `offer` from the live model where its assertion expected `proposed`. No calendar logic was changed for Flow F.
