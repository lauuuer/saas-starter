/**
 * Resilience integration test for the webhook claim protocol.
 *
 * WHAT THIS PROVES (and what it deliberately does not)
 * ----------------------------------------------------
 * The strongest part of this system is the *atomic claim*: the database's own
 * guarantees — a unique constraint and a conditional `updateMany` (compare-and-
 * swap) — are what prevent the handler and the worker from double-processing the
 * same Stripe event. That guarantee lives in Postgres, not in application code,
 * so a mock of Prisma would prove nothing: it would only confirm that the mock
 * behaves the way the test told it to. To actually prove the invariant, this
 * test runs the *real* claim queries against a *real* Postgres (via DATABASE_URL).
 *
 * It exercises the exact query sequence the route handlers use:
 *   - handler claim:    prisma.webhookEvent.create({ id })            -> P2002 on duplicate
 *   - reclaim (CAS):    updateMany({ where: { id, status }, ... })    -> count 0|1
 *   - worker candidate: findMany({ failed past nextRetryAt | stale processing })
 *   - failure outcome:  decideFailureOutcome(...)                     -> failed | dead_letter
 *
 * It does NOT import the Next.js route handlers themselves — those drag in
 * NextResponse, Stripe signature verification, etc., which are not the thing
 * under test. The unit of value here is the claim protocol against the DB.
 *
 * REQUIREMENTS: a reachable Postgres in DATABASE_URL with the Prisma schema
 * applied. In CI this is a service-container Postgres (see
 * .github/workflows/test.yml). Locally: `npm run test:resilience` (see README).
 * If DATABASE_URL is not set, the suite is skipped rather than failing, so the
 * fast unit tests can still run with no database.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaClient, Prisma, WebhookStatus } from "@prisma/client";
import {
  decideFailureOutcome,
  MAX_ATTEMPTS,
  STALE_PROCESSING_MS,
} from "@/lib/retry-policy";

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

// Lazily constructed inside beforeAll, so that when the suite is skipped (no
// DATABASE_URL) we never instantiate a client or touch the database at all.
let prisma: PrismaClient;

/** Reproduces the handler's claim insert. Returns 'won' or 'duplicate'. */
async function claim(id: string): Promise<"won" | "duplicate"> {
  try {
    await prisma.webhookEvent.create({
      data: {
        id,
        type: "customer.subscription.updated",
        status: WebhookStatus.processing,
        payload: "{}",
        attempts: 1,
      },
    });
    return "won";
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return "duplicate";
    }
    throw err;
  }
}

/** Reproduces the conditional CAS reclaim used by both handler and worker. */
async function reclaim(id: string, observed: WebhookStatus): Promise<number> {
  const r = await prisma.webhookEvent.updateMany({
    where: { id, status: observed },
    data: { status: WebhookStatus.processing, attempts: { increment: 1 } },
  });
  return r.count;
}

d("webhook claim protocol (against real Postgres)", () => {
  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.webhookEvent.deleteMany({});
  });

  afterAll(async () => {
    await prisma.webhookEvent.deleteMany({});
    await prisma.$disconnect();
  });

  it("lets exactly one concurrent invocation win the claim (idempotency under duplicate delivery)", async () => {
    // Stripe redelivers the same event; several invocations race to claim it.
    const results = await Promise.all([
      claim("evt_dup"),
      claim("evt_dup"),
      claim("evt_dup"),
      claim("evt_dup"),
    ]);

    expect(results.filter((r) => r === "won")).toHaveLength(1);
    expect(results.filter((r) => r === "duplicate")).toHaveLength(3);

    // The row exists exactly once.
    const count = await prisma.webhookEvent.count({ where: { id: "evt_dup" } });
    expect(count).toBe(1);
  });

  it("lets only one CAS reclaim win when handler and worker race the same failed event", async () => {
    await prisma.webhookEvent.create({
      data: {
        id: "evt_race",
        type: "x",
        status: WebhookStatus.failed,
        payload: "{}",
        attempts: 1,
        nextRetryAt: new Date(Date.now() - 60_000), // due
      },
    });

    // Handler (on redelivery) and worker both observe status 'failed' and both
    // attempt the CAS reclaim at the same time.
    const [a, b] = await Promise.all([
      reclaim("evt_race", WebhookStatus.failed),
      reclaim("evt_race", WebhookStatus.failed),
    ]);

    expect([a, b].filter((n) => n === 1)).toHaveLength(1); // one mutated
    expect([a, b].filter((n) => n === 0)).toHaveLength(1); // one lost

    // attempts incremented exactly once (not twice).
    const row = await prisma.webhookEvent.findUnique({
      where: { id: "evt_race" },
    });
    expect(row?.attempts).toBe(2);
    expect(row?.status).toBe(WebhookStatus.processing);
  });

  it("drives an event that fails N times into dead_letter and stops reprocessing", async () => {
    // Simulate the failure progression the way the handler/worker apply it:
    // each failed attempt calls decideFailureOutcome and writes the result.
    await prisma.webhookEvent.create({
      data: {
        id: "evt_dl",
        type: "x",
        status: WebhookStatus.processing,
        payload: "{}",
        attempts: 1,
      },
    });

    let attempts = 1;
    let terminal = false;
    // Loop more than MAX_ATTEMPTS to confirm it terminates rather than spinning.
    for (let i = 0; i < MAX_ATTEMPTS + 3 && !terminal; i++) {
      const outcome = decideFailureOutcome(attempts, "boom");
      await prisma.webhookEvent.update({
        where: { id: "evt_dl" },
        data: {
          status: WebhookStatus[outcome.data.status],
          lastError: outcome.data.lastError,
          nextRetryAt: outcome.data.nextRetryAt,
        },
      });
      if (outcome.isDeadLetter) {
        terminal = true;
        break;
      }
      // next retry: simulate the reclaim incrementing attempts.
      attempts += 1;
    }

    const row = await prisma.webhookEvent.findUnique({
      where: { id: "evt_dl" },
    });
    expect(row?.status).toBe(WebhookStatus.dead_letter);
    expect(row?.nextRetryAt).toBeNull(); // terminal: never scheduled again
    expect(attempts).toBe(MAX_ATTEMPTS); // crossed the ceiling, did not exceed it silently

    // A dead_letter row is NOT a worker candidate (it must not be reprocessed).
    const candidates = await prisma.webhookEvent.findMany({
      where: {
        OR: [
          {
            status: WebhookStatus.failed,
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
          },
          {
            status: WebhookStatus.processing,
            updatedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) },
          },
        ],
      },
    });
    expect(candidates.find((c) => c.id === "evt_dl")).toBeUndefined();
  });

  it("makes a stuck 'processing' event reclaimable once it goes stale", async () => {
    const staleUpdatedAt = new Date(Date.now() - (STALE_PROCESSING_MS + 60_000));

    // A row whose holder died mid-work: claimed (processing) but never finished.
    // We set updatedAt into the past to simulate the staleness window elapsing.
    await prisma.webhookEvent.create({
      data: {
        id: "evt_stuck",
        type: "x",
        status: WebhookStatus.processing,
        payload: "{}",
        attempts: 1,
      },
    });
    await prisma.$executeRaw`
      UPDATE "WebhookEvent" SET "updatedAt" = ${staleUpdatedAt} WHERE id = 'evt_stuck'
    `;

    // A fresh processing row that must NOT be reclaimed.
    await prisma.webhookEvent.create({
      data: {
        id: "evt_active",
        type: "x",
        status: WebhookStatus.processing,
        payload: "{}",
        attempts: 1,
      },
    });

    const staleThreshold = new Date(Date.now() - STALE_PROCESSING_MS);
    const candidates = await prisma.webhookEvent.findMany({
      where: {
        status: WebhookStatus.processing,
        updatedAt: { lt: staleThreshold },
      },
      select: { id: true },
    });

    const ids = candidates.map((c) => c.id);
    expect(ids).toContain("evt_stuck");
    expect(ids).not.toContain("evt_active");

    // And it can actually be reclaimed via the same CAS the worker uses.
    const reclaimed = await reclaim("evt_stuck", WebhookStatus.processing);
    expect(reclaimed).toBe(1);
  });
});
