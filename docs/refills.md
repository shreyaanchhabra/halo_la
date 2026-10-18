# Refill before it runs out (Flow E)

1. The pill count drops to 7 days left.
2. The errands agent shops on a pharmacy website and **stops before paying**.
3. The family sees "Refill Donepezil 5 mg, $12.40, approve?" in the care portal.
4. Approving, within the family's spending limit, places the order, and the pickup goes on the calendar.

## Where it lives

| What | Where |
| --- | --- |
| Pill count (one count, shared with the patient's "I took it" button) | `portal/src/meds.ts`: family count (`stock`) minus doses taken since |
| Refill lifecycle, approval rules, calendar entry | `portal/server/refills.ts` |
| Errands agent: built-in driver and Browser Use driver | `portal/server/errands.ts` |
| Test pharmacy website and its cart/order rules | `portal/server/pharmacy.ts` (served at `/test-pharmacy`) |
| Endpoints | `portal/server/refill-routes.ts` |
| Care portal UI | Medicines card in `portal/src/main.ts` |
| Saved state | `portal/data/refills.json`, `portal/data/pharmacy.json` |

Refills are re-checked whenever a dose is logged, the care data is saved (a new pill count or prescription), and once a minute.

## Rules that are enforced

- One open refill per medicine. A refill is cancelled if the pill count is updated so it is no longer due.
- The errands agent stops at the cart. The pharmacy site refuses "Place order" unless the family approved **that cart at that exact price**.
- Approval needs the family member's name, the exact price that was shown, a price that has not expired (30 minutes), and a price within the spending limit (default $25; set it in the Medicines card).
- Approving twice, or pressing Place order twice, never orders twice and never adds a second calendar entry.
- If something fails or HALO restarts mid-checkout, the refill goes to "needs a person" and is **never retried automatically**. If the pharmacy's own record shows an order was placed, that wins over the error.
- "Not now" pauses the refill until the family asks for a fresh price.
- "I have it" adds the tablets to the pill count once.

## Endpoints

| Method | Path | |
| --- | --- | --- |
| GET | `/api/refills` | refills, settings, activity log, which driver is in use |
| PUT | `/api/refills/settings` | `{ "spendingLimitCents": 2000 }` |
| POST | `/api/refills/check` | look at every medicine now |
| POST | `/api/refills/:id/approve` | `{ "approvedBy": "Maya", "expectedPriceCents": 1240 }` |
| POST | `/api/refills/:id/reject` \| `requote` \| `received` | |

## Errands agent

**Built in (default).** Works with no keys and no browser. It calls the test pharmacy in-process, through the same cart and approval rules the website uses. Prices are synthetic: Donepezil 5 mg × 30 is $12.40, Memantine 5 mg × 60 is $28.60, anything else is $0.45 a tablet. No real medicine is ordered and no money moves.

**Browser Use (real browser).** Set `BROWSER_USE_API_KEY` in `portal/.env` **and** `HALO_PHARMACY_URL` to a public address of this portal (for example an ngrok or Vultr URL), because Browser Use Cloud cannot reach `localhost`. The agent then runs twice: once to search, add to cart and stop on the review page, and once after approval to press "Place order". The result is checked against the pharmacy's own record before it is trusted.

> The Browser Use driver has **not** been run against the live service: no key was available when this was built. The built-in driver and everything around it is tested.

## Tests

`node --test portal/server/refills.test.ts portal/server/refill-routes.test.ts` covers the threshold, the quote, approval rules, limits, expiry, duplicates, failures, restarts, receipts and the pharmacy website over HTTP.

## Not included

There are no sign-ins yet, so "approved by" is a name the family member types, not a verified identity. Real pharmacy ordering, payment, and SMS or push notifications are out of scope: the approval appears in the care portal.
