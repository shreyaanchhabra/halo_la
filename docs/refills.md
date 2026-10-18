# Refill before it runs out (Flow E)

1. The pill count drops to 7 days left.
2. The errands agent looks up the cheapest **GoodRx** prices near the patient, using Browser Use, and stops. Nothing is bought.
3. The family sees "Refill Donepezil 5 mg: $12.40 at CVS (GoodRx coupon), approve?" in the care portal, with the other prices.
4. Approving, within the family's spending limit, puts a **pickup reminder** on the calendar.

HALO never places an order. GoodRx is a price and coupon site, so the family picks the medicine up at that pharmacy.

## Setup

Add to `portal/.env` and restart the portal:

```
BROWSER_USE_API_KEY=...
```

Save the patient's **ZIP code** on the setup page. Prices are looked up for that area. Without a key or a ZIP code, the refill says what is missing instead of showing made-up prices.

## Where it lives

| What | Where |
| --- | --- |
| Pill count (one count, shared with the patient's "I took it" button) | `portal/src/meds.ts`: family count (`stock`) minus doses taken since |
| Refill lifecycle and approval rules | `portal/server/refills.ts` |
| Errands agent: GoodRx price lookup through Browser Use | `portal/server/errands.ts`, `portal/server/goodrx.ts` |
| Endpoints | `portal/server/refill-routes.ts` |
| Care portal UI | Medicines card in `portal/src/main.ts` |
| Saved state | `portal/data/refills.json` |

Refills are re-checked whenever a dose is logged, the care data is saved (a new pill count, a prescription, the ZIP code), and once a minute.

## Rules

- One open refill per medicine. A refill is cancelled if the pill count is updated so it is no longer due.
- **A lookup only starts when a refill is due**, and only once per refill. Each lookup uses Browser Use credits (the code caps one at $1 and 8 minutes), so checking again and again never repeats it.
- The family sees the five cheapest prices. The cheapest is the one that is approved.
- Approval needs the family member's name, the exact price that was shown, prices that are not out of date (6 hours), and a price within the spending limit (default $25; set it in the Medicines card).
- Approving twice never adds a second reminder.
- "Not now" stops HALO looking again until the family asks. A failed lookup waits for a person and is never retried automatically.
- The pickup reminder is for tomorrow at 10:00. Move it on the calendar if you go at another time.
- "I have it" adds the tablets to the pill count once. GoodRx may offer the closest size; the count goes up by the size that was priced.

## Endpoints

| Method | Path | |
| --- | --- | --- |
| GET | `/api/refills` | refills, settings, activity log, where prices come from |
| PUT | `/api/refills/settings` | `{ "spendingLimitCents": 2000 }` |
| POST | `/api/refills/check` | look at every medicine now |
| POST | `/api/refills/:id/approve` | `{ "approvedBy": "Maya", "expectedPriceCents": 1240 }` |
| POST | `/api/refills/:id/reject` \| `requote` \| `received` | |

## Tests

`node --test portal/server/refills.test.ts portal/server/refill-routes.test.ts` covers the threshold, the price finder (sorting, cents, bad prices, missing ZIP, no prices), approval rules, limits, expiry, duplicates, failures, restarts, receipts, and the endpoints over HTTP. GoodRx is faked in the tests, so they cost nothing.

## Not included

GoodRx does not take orders, so nothing is ordered or paid for through HALO. There are no sign-ins yet, so "approved by" is a name the family member types, not a verified identity. There is no SMS or push notification: the approval appears in the care portal.
