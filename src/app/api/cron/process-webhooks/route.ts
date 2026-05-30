import { NextResponse } from "next/server";
import { WebhookStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { log, serializeError } from "@/lib/logger";
import { withTimeout } from "@/lib/subscription";
import { processEvent, parseStoredEvent } from "@/lib/webhook-processor";
import { decideFailureOutcome, STALE_PROCESSING_MS } from "@/lib/retry-policy";

export const runtime = "nodejs";
// Evita que a plataforma faça cache da resposta do cron.
export const dynamic = "force-dynamic";
// Limite de tempo da função. No Hobby o teto é 60s; deixamos margem para o lote.
export const maxDuration = 60;

// Quantos eventos processar por execução.
// NOTA SOBRE O PLANO GRÁTIS: o Vercel Cron no plano Hobby roda no máximo 1x/dia
// e NÃO faz retry de invocações falhas. Como o Stripe já reentrega eventos com
// falha por várias horas (primeira linha de defesa), este worker é a rede de
// segurança de ÚLTIMO recurso para eventos que o Stripe desistiu de entregar.
// Por isso o batch é generoso: queremos drenar o backlog numa única passada
// diária. Em produção real (plano Pro), reduza o batch e aumente a frequência
// (ex.: a cada 5min) ajustando o schedule em vercel.json.
const BATCH_SIZE = 50;

// Timeout por evento dentro do worker (igual ao do handler síncrono).
const PER_EVENT_TIMEOUT_MS = 9_000;

/**
 * Worker assíncrono de reprocessamento de webhooks.
 *
 * Segunda linha de defesa: o Stripe reentrega eventos com falha por um tempo,
 * mas eventualmente desiste. Este worker assume os eventos que ficaram em
 * `failed` (ou `processing` preso) e os reprocessa com backoff, movendo para
 * `dead_letter` após MAX_ATTEMPTS para inspeção manual.
 *
 * Acionado pelo Vercel Cron (gratuito). Protegido por CRON_SECRET para que o
 * endpoint público não possa ser disparado por terceiros.
 */
export async function GET(req: Request) {
  // AuthZ: a Vercel injeta `Authorization: Bearer <CRON_SECRET>` nas chamadas
  // de cron. Sem isso, qualquer um na internet acionaria o worker.
  const authHeader = req.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_PROCESSING_MS);

  // Seleciona candidatos: failed cujo nextRetryAt já passou (ou nulo), ou
  // processing preso (stale). Ordena pelos mais antigos primeiro (FIFO justo).
  const candidates = await prisma.webhookEvent.findMany({
    where: {
      OR: [
        {
          status: WebhookStatus.failed,
          OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
        },
        {
          status: WebhookStatus.processing,
          updatedAt: { lt: staleThreshold },
        },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
    select: { id: true, type: true, status: true, attempts: true },
  });

  let processed = 0;
  let deadLettered = 0;
  let reFailed = 0;

  // Deadline do loop: para de pegar novos eventos antes de bater o maxDuration
  // da função (60s), deixando folga para finalizar o evento em curso e responder.
  // Sem isso, a função poderia ser morta no meio de um evento (que ficaria preso
  // em processing até o reclaim por staleness).
  const LOOP_DEADLINE_MS = 50_000;
  const startedAt = Date.now();

  for (const candidate of candidates) {
    if (Date.now() - startedAt > LOOP_DEADLINE_MS) {
      log.warn("worker.deadline_reached", {
        remaining: candidates.length - processed - reFailed - deadLettered,
      });
      break;
    }
    // CLAIM atômico por evento: só prossegue quem conseguir mudar o status
    // a partir do estado observado. Se outra execução do cron (ou o handler)
    // já reivindicou, count=0 e pulamos — sem dupla execução concorrente.
    const claimed = await prisma.webhookEvent.updateMany({
      where: { id: candidate.id, status: candidate.status },
      data: { status: WebhookStatus.processing, attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue;

    const attempts = candidate.attempts + 1;
    const logBase = { eventId: candidate.id, eventType: candidate.type, attempts };

    try {
      const stored = await prisma.webhookEvent.findUnique({
        where: { id: candidate.id },
        select: { payload: true },
      });
      if (!stored) continue;

      const event = parseStoredEvent(stored.payload);
      await withTimeout(
        processEvent(event),
        PER_EVENT_TIMEOUT_MS,
        `worker.processEvent(${candidate.type})`
      );

      await prisma.webhookEvent.update({
        where: { id: candidate.id },
        data: { status: WebhookStatus.processed, nextRetryAt: null },
      });
      processed++;
      log.info("worker.processed", logBase);
    } catch (err) {
      // Desfecho compartilhado com o handler: failed com backoff, ou dead_letter
      // (terminal) ao exceder o teto. Mesma política nos dois caminhos.
      const errorMessage = err instanceof Error ? err.message : String(err);
      const outcome = decideFailureOutcome(attempts, errorMessage, now);

      await prisma.webhookEvent
        .update({
          where: { id: candidate.id },
          data: {
            status: WebhookStatus[outcome.data.status],
            lastError: outcome.data.lastError,
            nextRetryAt: outcome.data.nextRetryAt,
          },
        })
        .catch((updErr) =>
          log.error("worker.mark_failed_error", {
            ...logBase,
            ...serializeError(updErr),
          })
        );

      if (outcome.isDeadLetter) {
        deadLettered++;
        // dead_letter deve disparar alarme (billing dessincronizado p/ esse user).
        log.error("worker.dead_letter", logBase);
      } else {
        reFailed++;
        log.error("worker.event_failed", { ...logBase, ...serializeError(err) });
      }
    }
  }

  // Métrica de saúde: util para alarme (ex.: dead_letter > 0, ou backlog alto).
  const summary = {
    scanned: candidates.length,
    processed,
    reFailed,
    deadLettered,
  };
  log.info("worker.run_complete", summary);
  return NextResponse.json({ ok: true, ...summary });
}
