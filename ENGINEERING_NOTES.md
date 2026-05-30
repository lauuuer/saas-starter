# Engineering Notes

A record of the architecture, the problems hit while building and deploying, and how each was resolved. The goal is to show the reasoning, not just the final result.

---

## 1. Architecture overview

A subscription SaaS on a single Next.js 15 (App Router) codebase — frontend and backend in one deploy.

```
Browser
  │
  ├─ NextAuth (Auth.js v5) ── GitHub OAuth ── session
  │
  ├─ /pricing ── CheckoutButton ──► POST /api/stripe/checkout ──► Stripe Checkout
  │                                                                   │
  │                                              (user pays on Stripe-hosted page)
  │                                                                   │
  └─ /dashboard ◄── getActiveSubscription() ◄── Postgres ◄───────────┘
                                                    ▲
                                                    │
            Stripe ──► POST /api/stripe/webhook ────┤  (signature-verified, idempotent)
                                                    │
                       Vercel Cron ──► /api/cron/process-webhooks  (retry safety net)
```

**Stack:** Next.js 15 · Auth.js v5 · Prisma · PostgreSQL (Supabase) · Stripe · Tailwind · Vercel.

**Core design principle:** the source of truth for "is this user Pro?" is the database, written only by signature-verified Stripe webhooks. The success redirect (`/dashboard?checkout=success`) is treated as a UI hint, never as proof of payment.

### Why the webhook pipeline is the centerpiece

A checkout that "works" is easy. The hard part is making the billing state survive the messy reality of webhooks: duplicate deliveries, out-of-order events, transient failures, serverless cold-start kills, and Stripe's multi-day redelivery. The handler is built around that reality:

- **Claim-then-process idempotency.** The `event.id` is inserted into a `WebhookEvent` table *before* processing. The unique constraint is the lock — a duplicate delivery fails the insert (`P2002`) and exits early. The DB is the concurrency barrier, not an application-level check (which has a check-then-act race).
- **Bounded retries with backoff + jitter**, moving to `dead_letter` after a ceiling instead of looping forever on a deterministic failure.
- **A cron worker** as a second line of defense, reusing the same `processEvent` logic so both paths behave identically.
- **A health endpoint** exposing aggregate pipeline state for external monitoring.

---

## 2. Problems hit and how they were solved

Roughly in the order they happened.

### Setup & database

**Supabase connection string moved in the UI.** The docs pointed to `Settings → Database → Connection string`, but the current dashboard exposes strings behind the **Connect** button in the top bar. Used the **Transaction pooler** (port 6543) for `DATABASE_URL` and the **Direct connection** (5432) for `DIRECT_URL`.

**`P1013: empty host in database URL`.** The database password contained an `@`, which the URL parser read as the user/host separator, leaving an "empty host." Fixed by resetting the password to one without special characters (alternative would have been percent-encoding `@` as `%40`). Lesson baked into the README: prefer special-char-free DB passwords to avoid URL-encoding traps in every environment.

### Local dev

**Next.js silently installed 16.x instead of 15.x.** A stray `package-lock.json` in a parent directory (`C:\Users\Lucas\`) confused Next's workspace-root detection, and the install resolved a newer major. Next 16 renamed the `middleware.ts` convention to `proxy.ts`, so the existing middleware export wasn't recognized. Fixed by removing the stray lockfile and pinning back to the tested Next 15 line. Decision: stay on the version the project was written for rather than chase a major mid-build.

**Webhook test showed `Trigger succeeded` but nothing processed.** `stripe trigger` only confirms the event was created on Stripe's side. The first run was missing `--forward-to`, so events never reached localhost. Once forwarding was added, deliveries returned `[200]` — but `stripe trigger` uses synthetic fixtures (fake customer, no real `userId`), so it validates signature + idempotency, not the subscription↔user link. The real validation is a UI checkout with test card `4242…`.

### The subscription wasn't linking (timing race)

After a real checkout, the dashboard showed "no plan" — but a page refresh fixed it. The redirect to `/dashboard?checkout=success` rendered in the same instant the webhook was still writing the subscription. Confirmed via Prisma Studio that the row was correct (`status: active`, valid `currentPeriodEnd`). Not a bug — a timing gap between redirect and async webhook. This is exactly why the success redirect is never treated as proof of payment.

### Webhook 500s under load (the most instructive one)

A burst of events during checkout produced several `[500]` responses (20+ second durations). Investigation showed the cause in `lastError`: **`Timeout (9000ms) in processEvent`**. Two compounding factors, both environmental:

1. **Cross-region latency.** Supabase was provisioned in `us-east-2` (Ohio) while developing from Brazil; every Prisma query and `stripe.subscriptions.retrieve` crossed the continent.
2. **Concurrent burst + `connection_limit=1`.** The serverless-correct pool size means concurrent queries queue, stacking latency until the 9s processing timeout tripped.

The key insight: **the 500s were the system working as designed.** Failed events were marked `failed` with a `nextRetryAt`, and Stripe's redelivery (plus the subsequent `[200]`s) reconciled the final state correctly. The timeout-then-retry behavior absorbed the transient slowness. No code change — the right fix for production is co-locating the DB and the deploy region, not loosening the timeout.

### Deployment to Vercel

**Build failed: `Type '"2024-12-18.acacia"' is not assignable to type '"2025-02-24.acacia"'`.** The `^17.5.0` Stripe SDK resolved to a version expecting a newer pinned `apiVersion` than the code declared. Strict TypeScript in `next build` (which `next dev` tolerates) caught it. Fixed by aligning the `apiVersion` literal. Follow-up: this is the cost of `^` ranges — builds aren't reproducible. Recommended pinning exact versions for a portfolio project.

**Build blocked: "Vulnerable version of Next.js detected."** Vercel refuses to publish builds on Next versions with a known critical CVE (CVE-2025-66478, RSC RCE, CVSS 10.0). The build compiled fine; Vercel blocked it on policy. Upgraded to the patched line (`15.1.11`) and React to `19.0.3` — staying within the 15.1 line means no breaking changes, unlike jumping to 16. (The official advice to rotate secrets after patching was noted; low-risk here since it's test mode.)

**`EPERM: operation not permitted, rename query_engine-windows.dll.node` (local only).** Prisma's engine file was locked by a running process (`prisma studio` / `next dev`). Windows-only, irrelevant to the Linux build on Vercel. Fixed by closing the processes holding the file.

### Internationalization

The starter shipped in Portuguese. Translated all UI (5 pages + 2 components), the layout metadata, and `<html lang>`, plus switched the dashboard date from `toLocaleDateString("pt-BR")` to `en-US`. Escaped the apostrophe in JSX (`don&apos;t`) since a raw apostrophe breaks Next's strict lint.

### Tests

Added Vitest unit tests for the retry policy (backoff growth, 1h cap, jitter bounds, dead-letter threshold, clock-injected `nextRetryAt`). Two config snags along the way:

- `vite-tsconfig-paths` is ESM-only and broke the config loader; replaced it with a direct `@` alias in `vitest.config.ts`.
- `next build` type-checked `vitest.config.ts` and the `.test.ts` files (the `tsconfig` `include` globs all `.ts`), failing because test deps aren't part of the app. Fixed by adding `**/*.test.ts` and `vitest.config.ts` to `tsconfig` `exclude`.

---

## 3. Resilience decisions baked into the code

Documented to show the reasoning behind specific choices:

- **Stripe API version compatibility.** Recent Stripe versions moved `current_period_end` from the subscription to each item. Reading the old field returns `undefined` silently — which in billing means denying access to a paying user. `extractCurrentPeriodEnd` reads item-level with a top-level fallback.
- **Stripe Customer creation race.** Two concurrent checkouts could create two Customers. An `idempotencyKey` derived from the `userId` makes Stripe return the same one.
- **Self-healing reconciliation.** `syncSubscription` reconciles by `stripeCustomerId`, falling back to a `userId` carried in metadata (set on both the checkout session and the subscription) and repairing the link if the first write failed.
- **Explicit status mapping.** An unknown Stripe status throws (entering the retry flow) rather than writing invalid data via `as any`.
- **Surface hardening.** A real-byte body-size cap on the public webhook endpoint; the cron worker is protected by `CRON_SECRET`.

---

## 4. Known trade-offs (free-tier constraints)

- **Inline processing instead of a true queue.** The maximally robust pattern returns `2xx` immediately and processes in a separate worker/queue. To stay 100% free with no extra infra, processing runs inline with a timeout and atomic claim, with the raw payload persisted so a worker can take over later. Conscious middle path.
- **Vercel Cron runs once/day on Hobby** and doesn't retry failed invocations, so the worker uses a large batch to drain the backlog in one pass. Stripe covers the first hours of retries, so a daily safety net is sufficient. On a paid plan: smaller batch, `*/5 * * * *` schedule.
- **DB region.** Should be co-located with the deploy region in production. The cross-region setup used here is fine for a portfolio demo but is the root cause of the local timeout observations above.

---

## 5. What I'd do next (production hardening)

- Move side-effect processing to a real queue (e.g. a durable job runner) and return `2xx` on persist.
- Co-locate Postgres with the Vercel region.
- Add an integration test for the claim-then-process path against a test database.
- Wire the health endpoint to an external monitor with alerting on `dead_letter > 0`.
- Pin exact dependency versions for reproducible builds.
