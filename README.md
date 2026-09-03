# JSONalytics

I fix broken Shopify tracking, GTM, GA4, Meta Pixel, TikTok Pixel, consent,
server-side CAPI. This is the tool behind that work: point it at a storefront
URL and it traces the real tracking/measurement pipeline back to the
earliest real cause, instead of just listing what's present or absent, so
the fix goes to the actual break, not a symptom.

Operating philosophy: **LOCATE → POINT → GUIDE**. Every finding states what
was observed, what it proves, what it does *not* prove, and what to check
first. Nothing is inferred beyond what the evidence supports, no fix
recommendation without evidence behind it.

## Requirements

- Node.js 20+ (tested on Node 24)
- `npm install` once, after cloning

## Running it

This app has two halves that both need to be running: the Vite frontend
(`localhost:5173`) and the local Express/Puppeteer backend (`127.0.0.1:4000`,
which Vite proxies `/api/*` requests to). You do not need to juggle two
terminals manually:

```bash
npm run dev:all
```

This starts both together and stops both together on Ctrl+C. Open
`http://localhost:5173`.

If you do need them separately (e.g. debugging the backend on its own):

```bash
npm run server   # backend only, http://127.0.0.1:4000
npm run dev      # frontend only, http://localhost:5173 (backend must already be running)
```

Without the backend running, the frontend's scan/audit actions will fail
with a clear "could not reach store" / connection error rather than silently
faking a result.

## Configuration

Copy your own values into a `.env` file in the project root (see the
placeholder comments already in `.env` for the exact variable names):
Shopify custom-app access token (or client credentials), and GA4/GTM OAuth
client credentials + redirect URIs if you want live GA4/GTM API access from
the "With Access" tab. None of this is required for the read-only "No
Access" surface/deep scan tabs — those only need a store URL.

`.env` and `tokens.json` (where OAuth tokens get cached after you connect
GA4/GTM) are both gitignored. Never commit or share either file.

### Meta Ad Library search (lead sourcing)

Optional — powers the "Find leads via Meta Ad Library" search in the Lead
Register tab. Requires a `META_AD_LIBRARY_TOKEN` in `.env`:

1. Go to [developers.facebook.com](https://developers.facebook.com), create
   an app (choose a generic/non-advertising type).
2. Complete Meta's identity verification for Ad Library API access — this is
   the real gate, tied to your own account, not just an app-review checkbox.
3. In Graph API Explorer, generate a user access token with `ads_read`
   permission and put it in `.env` as `META_AD_LIBRARY_TOKEN`.

Without this set, the search box shows a clear "not configured" message
instead of failing silently. Rate limit: 200 calls/hour per token (Meta's
limit, not enforced separately by this app).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev:all` | Frontend + backend together (recommended for local use) |
| `npm run dev` | Frontend only |
| `npm run server` | Backend only |
| `npm run build` | Type-check (`tsc -b`) then production build (`vite build`) |
| `npm test` | Runs the test suite (`node --test`) |
| `npm run lint` | Runs oxlint |
| `npm run preview` | Preview a production build locally |

## Safety model

Normal scans (both the static HTML scan and the headless-browser deep scan)
are strictly read-only: they never click Add to Cart, submit forms, create
carts, or navigate checkout, and they never mutate store/customer state. A
tracking request observed during a page-load scan is evidence that a request
fired — it is never treated as proof that a business action (like a
purchase) actually occurred. See `tests/audit-safety.test.cjs` for the tests
that enforce this.

Because the scanner accepts arbitrary operator-supplied URLs and both
fetches them and navigates a real browser to them, `lib/ssrfGuard.cjs`
blocks loopback/private/link-local/reserved targets (including the common
cloud-metadata address) before every scan. See `tests/ssrf-guard.test.cjs`.

## Markets

The market selector (US / UK / CA / AU / IN / NZ) drives report currency
formatting and privacy-law language (CCPA/CPRA, UK GDPR, PIPEDA, Australian
Privacy Act, DPDP) — it is not cosmetic. See `src/utils/constants.ts`.

## Lead register

The "Leads" tab is a lean pipeline tracker, separate from the diagnostic engine —
store URL, status (`Interested` / `Not interested` / `In queue` / `In
progress`), optional notes. Persists to `leads.json` (same pattern as
`tokens.json`: local file, gitignored, never committed). Not a CRM — no
history, no reminders, just "who to follow up with."
