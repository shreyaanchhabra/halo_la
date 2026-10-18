# Part E: Refill before it runs out

Implemented in the existing HALO Node/TypeScript backend and Vite care portal.
The default flow is a synthetic test pharmacy. It never orders real medicine or charges money.

## Run the demo

From the repository root, start these in two terminals:

```sh
npm run server
npm run portal
```

Open http://localhost:5174/refills.html (or the port Vite prints), or choose **Medicine refills** in care setup.

1. Enter **Maya** as the family approver. The initial per-order limit is **$20 USD**.
2. Add the synthetic **Donepezil 5 mg** prescription, reference **demo-rx-001**, doctor **Dr. Patel**, **1 tablet per day**, **8 tablets remaining**. Check the confirmation box.
3. Click **Confirm 1 tablet taken**. Stock becomes 7 and one **$12.40** quote for 30 tablets appears.
4. Click **Approve $12.40**. The test pharmacy returns a receipt and a pickup time one day later. The event appears in the existing shared calendar.
5. Stock stays at 7 until **Confirm medicine received**. It then becomes 37.

To demonstrate a blocked approval, set the limit below $12.40. To demonstrate rejection, reject a quote and run **Check stock** again: it stays rejected until the family requests a new quote.

## What is included

- Refill threshold uses remaining tablets divided by the confirmed daily tablet count.
- Doctor/prescription provenance is required. Catalog and quantities are limited to synthetic test products.
- Stable dose event IDs prevent repeated requests from decrementing stock twice.
- One outstanding refill per medication, including rejected or uncertain orders.
- Quotes expire after 30 minutes. Approval binds to the exact price; checkout rechecks the current limit and expiry.
- Repeated checkout and receipt calls are idempotent. Interrupted checkouts require review rather than automatic reordering.
- Approval name, source prescription, quote, order, receipt and stock changes are logged.
- Refill state persists atomically to `server/data/refills.json`. The calendar remains in the existing store. An order-specific event ID prevents duplicate pickup events, including recovery after restart.

## Part D integration

After recording a confirmed dose, call:

```http
POST /api/refills/medications/MEDICATION_ID/doses
Content-Type: application/json

{"eventId":"stable-dose-event-id","tablets":1}
```

Reuse that exact event ID when retrying a network request. Do not call this for unconfirmed reminders. The refill module tracks its own stock; Part D should use this endpoint as the stock update rather than decrementing a second copy.

Register a confirmed prescription with `POST /api/refills/medications`:

```json
{
  "sku": "donepezil-5mg-30",
  "prescriptionId": "demo-rx-001",
  "doctor": "Dr. Patel",
  "doctorConfirmed": true,
  "tabletsPerDay": 1,
  "tabletsRemaining": 8
}
```

Other endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/refills` | Stock, quotes, orders, settings and activity |
| PUT | `/api/refills/settings` | `{ "spendingLimitCents": 2000 }` |
| POST | `/api/refills/check` | Scan stock and resume pending quote preparation |
| POST | `/api/refills/:id/approve` | `{ "approvedBy": "Maya", "expectedTotalCents": 1240 }` |
| POST | `/api/refills/:id/reject` | Reject without automatic retry |
| POST | `/api/refills/:id/requote` | Fresh quote after expiry or rejection |
| POST | `/api/refills/:id/received` | Confirm arrival and credit stock once |

## Optional Browser Use driver

The default adapter completes the local test pharmacy transitions directly. It does **not** claim browser automation.
`server/refill_browser.py` provides a second driver that uses Browser Use to click the test pharmacy pages at `/test-pharmacy/refills/:id`.
It runs twice: prepare a quote and stop; then, only after portal approval, place the approved test order. Backend checks enforce the approval even if the browser clicks early.

This driver requires Python 3.11+, Browser Use, Chromium and a `BROWSER_USE_API_KEY` in the server environment. Install it separately if you want to demo Browser Use:

```sh
python3.12 -m venv .venv-refills
.venv-refills/bin/pip install -r server/requirements-refills.txt
.venv-refills/bin/python -m playwright install chromium
```

Set the key securely in your environment, then start the server with:

```sh
HALO_REFILL_DRIVER=browser-use HALO_BROWSER_PYTHON="$PWD/.venv-refills/bin/python" npm run server
```

If the backend port changes, also set `HALO_TEST_PHARMACY_ORIGIN` to that loopback origin. Browser Use is restricted to the local synthetic site. Automation failures are visible as **Needs manual review**, without silently falling back to a fake browser success.

The Browser Use driver has been syntax checked but has not been exercised against the model service. Its dependencies and credentials are not installed/configured by this change.

## Validation

```sh
node --test server/refills.test.ts server/refill-routes.test.ts
npx tsc --noEmit
npx tsc -p portal/tsconfig.json --noEmit
npm run build
npx vite build portal
```

The refill suite covers threshold crossing, duplicate doses/orders, quote expiry, spending limits, rejected and uncertain orders, receipt stock updates, and an HTTP integration flow through the test pharmacy and shared calendar.

## Scope

This is a hackathon demo with manually confirmed synthetic prescriptions. Existing portal setup has no authenticated family/doctor roles, so approver names and doctor confirmation are declarations, not verified identities. Connect real role authentication and a pharmacy integration before using real prescriptions. There is no SMS/push delivery in Part E: the approval appears in the care portal, including on a caregiver's phone. No real payment integration is claimed. Tablets only; variable or as-needed regimens are outside this demo.

Code is left uncommitted and unpushed, alongside the existing in-progress work.
