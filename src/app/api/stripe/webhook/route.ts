import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { Prisma, WebhookStatus } from "@prisma/client";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { log, serializeError } from "@/lib/logger";
import { withTimeout } from "@/lib/subscription";
import { processEvent, HANDLED_EVENTS } from "@/lib/webhook-processor";
import { decideFailureOutcome, STALE_PROCESSING_MS } from "@/lib/retry-policy";

// O SDK do Stripe exige o runtime Node.js (não roda no Edge).
export const runtime = "nodejs";

// Limite de tamanho do body do endpoint público (defesa contra payload abusivo).
// Eventos do Stripe são pequenos; 1MB é folgado e ainda protege.
const MAX_BODY_BYTES = 1_000_000;

export async function POST(req: Request) {
  // Correlação: usa o request id da plataforma se houver, senão gera um.
  const requestId =
    req.headers.get("x-vercel-id") ?? crypto.randomUUID();

  // 1) Ler o RAW body ANTES de qualquer parse (obrigatório p/ a assinatura bater).
  const body = await req.text();

  // Defesa de superfície: rejeita payloads absurdamente grandes cedo.
  // Buffer.byteLength conta bytes reais (UTF-8), não unidades de código UTF-16.
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    log.warn("webhook.body_too_large", {
      requestId,
      bytes: Buffer.byteLength(body, "utf8"),
    });
    return NextResponse.json({ error: "Payload muito grande" }, { status: 413 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    log.warn("webhook.missing_signature", { requestId });
    return NextResponse.json({ error: "Sem assinatura" }, { status: 400 });
  }

  // 2) Verificar a assinatura. Falha aqui = 400 (não reentregar; é inválido).
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    log.warn("webhook.invalid_signature", {
      requestId,
      ...serializeError(err),
    });
    return NextResponse.json({ error: "Assinatura inválida" }, { status: 400 });
  }

  const logBase = {
    requestId,
    eventId: event.id,
    eventType: event.type,
  };

  // Nº da tentativa em curso (1 no primeiro recebimento; incrementa a cada
  // reclaim). Capturado aqui para o branch de falha calcular backoff/dead-letter
  // sem uma query extra ao banco.
  let currentAttempts = 1;

  // 3) CLAIM atômico (idempotência à prova de concorrência).
  //    Tenta inserir o event.id com status "processing". Se o insert falhar com
  //    violação de unique (P2002), OUTRA invocação já pegou este evento:
  //    é duplicata/reentrega concorrente -> retorna 2xx sem reprocessar.
  //    O unique constraint VIRA o lock, em vez de ser uma checagem tardia.
  try {
    await prisma.webhookEvent.create({
      data: {
        id: event.id,
        type: event.type,
        status: WebhookStatus.processing,
        payload: body, // payload cru: permite reprocessamento assíncrono futuro
        attempts: 1,
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // Já existe um registro para este event.id. Decide pelo estado atual:
      //  - processed   -> duplicata real; ignora (2xx).
      //  - processing   -> outra invocação está processando AGORA; ignora (2xx),
      //                    pois ela é a responsável. (Evita dupla execução concorrente.)
      //  - failed       -> tentativa anterior falhou; ESTE retry deve reprocessar.
      const existing = await prisma.webhookEvent.findUnique({
        where: { id: event.id },
        select: { status: true, attempts: true, updatedAt: true },
      });

      // Janela após a qual um evento "processing" é considerado preso (invocação
      // anterior morreu sem finalizar). Definida na política de retry compartilhada.
      const isStaleProcessing =
        existing?.status === WebhookStatus.processing &&
        Date.now() - existing.updatedAt.getTime() > STALE_PROCESSING_MS;

      const isReprocessable =
        existing?.status === WebhookStatus.failed || isStaleProcessing;

      if (!existing || !isReprocessable) {
        log.info("webhook.duplicate_ignored", {
          ...logBase,
          existingStatus: existing?.status ?? "unknown",
        });
        return NextResponse.json({ received: true, duplicate: true });
      }

      // Reclaim: CAS condicionado ao status observado. Se outra invocação já
      // reclamou nesse meio-tempo, count=0 e tratamos como duplicata.
      const reclaimed = await prisma.webhookEvent.updateMany({
        where: { id: event.id, status: existing.status },
        data: {
          status: WebhookStatus.processing,
          attempts: { increment: 1 },
        },
      });
      if (reclaimed.count === 0) {
        log.info("webhook.duplicate_ignored", {
          ...logBase,
          existingStatus: "reclaimed_by_other",
        });
        return NextResponse.json({ received: true, duplicate: true });
      }
      currentAttempts = existing.attempts + 1;
      log.info("webhook.reprocessing", { ...logBase, attempt: currentAttempts });
      // cai para o bloco de processamento abaixo
    } else {
      // Falha de banco no claim (ex.: pool esgotado): NÃO confirmar.
      // Retornar 500 faz o Stripe reentregar mais tarde (comportamento desejado).
      log.error("webhook.claim_failed", { ...logBase, ...serializeError(err) });
      return NextResponse.json(
        { error: "Erro de persistência" },
        { status: 500 }
      );
    }
  }

  // Evento não tratado: já está persistido (claim). Marca processed e sai.
  // (Fica registrado para auditoria, sem custo de processamento.)
  if (!HANDLED_EVENTS.has(event.type)) {
    await prisma.webhookEvent
      .update({
        where: { id: event.id },
        data: { status: WebhookStatus.processed },
      })
      .catch((err) =>
        log.warn("webhook.mark_processed_failed", {
          ...logBase,
          ...serializeError(err),
        })
      );
    return NextResponse.json({ received: true, handled: false });
  }

  // 4) Processa o efeito de negócio, com guarda de tempo global.
  //    Se o processamento falhar, marca o evento como "failed" (com o erro) e
  //    retorna 500 -> Stripe reentrega; a reentrega cai no claim e, como o id
  //    já existe com status failed, o branch abaixo decide reprocessar.
  try {
    await withTimeout(processEvent(event), 9_000, `processEvent(${event.type})`);

    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status: WebhookStatus.processed },
    });

    log.info("webhook.processed", logBase);
    return NextResponse.json({ received: true });
  } catch (err) {
    // Decide o desfecho de forma compartilhada com o worker: failed com backoff,
    // ou dead_letter (terminal) ao exceder o teto de tentativas.
    const errorMessage = err instanceof Error ? err.message : String(err);
    const outcome = decideFailureOutcome(currentAttempts, errorMessage);

    await prisma.webhookEvent
      .update({
        where: { id: event.id },
        data: {
          status: WebhookStatus[outcome.data.status],
          lastError: outcome.data.lastError,
          nextRetryAt: outcome.data.nextRetryAt,
        },
      })
      .catch((updErr) =>
        log.error("webhook.mark_failed_error", {
          ...logBase,
          ...serializeError(updErr),
        })
      );

    if (outcome.isDeadLetter) {
      // Excedeu o teto. NÃO pedir reentrega (200): o Stripe insistiria por até
      // 3 dias num evento que já desistimos de processar automaticamente. O log
      // de erro abaixo deve disparar alarme (billing dessincronizado p/ esse user).
      log.error("webhook.dead_letter", { ...logBase, attempts: currentAttempts });
      return NextResponse.json({ received: true, deadLetter: true });
    }

    log.error("webhook.processing_failed", {
      ...logBase,
      attempts: currentAttempts,
      ...serializeError(err),
    });
    // 500 -> Stripe reentrega (1ª linha de defesa). Se o Stripe desistir antes
    // do teto, o worker assíncrono assume via nextRetryAt. Efeito é idempotente.
    return NextResponse.json({ error: "Falha no processamento" }, { status: 500 });
  }
}
