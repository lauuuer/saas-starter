import { NextResponse } from "next/server";
import { WebhookStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { log, serializeError } from "@/lib/logger";
import { STALE_PROCESSING_MS } from "@/lib/retry-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Limiares de saúde. Ajuste conforme o volume real do seu app.
//  - Qualquer dead_letter já é "unhealthy": significa billing dessincronizado
//    para pelo menos um usuário, exigindo intervenção manual.
//  - Backlog de failed acima do limiar, ou um evento pendente muito antigo,
//    indica que o worker não está drenando (ex.: cron parado) -> "degraded".
const FAILED_BACKLOG_DEGRADED = 10;
const OLDEST_PENDING_DEGRADED_MS = 6 * 60 * 60 * 1000; // 6h

type Health = "healthy" | "degraded" | "unhealthy";

/**
 * Endpoint de observabilidade do pipeline de webhooks.
 *
 * Projetado para ser consumido por um monitor HTTP externo (UptimeRobot,
 * BetterStack, Pingdom — todos com free tier): configure um check que alerta
 * quando o corpo contém "unhealthy" ou quando o HTTP status é 503.
 *
 * NÃO expõe PII nem payloads — apenas contagens e timestamps agregados.
 * Protegido por HEALTH_TOKEN para não vazar telemetria operacional ao público.
 */
export async function GET(req: Request) {
  // AuthZ leve: telemetria operacional não deve ser pública. Aceita o token via
  // header Authorization: Bearer <HEALTH_TOKEN> ou ?token= (para monitores que
  // não permitem custom headers no free tier).
  const token = process.env.HEALTH_TOKEN;
  if (token) {
    const url = new URL(req.url);
    const provided =
      req.headers.get("authorization")?.replace("Bearer ", "") ??
      url.searchParams.get("token");
    if (provided !== token) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }
  }

  try {
    const now = Date.now();
    const staleThreshold = new Date(now - STALE_PROCESSING_MS);

    // Uma única query agregada por status (evita N queries).
    const grouped = await prisma.webhookEvent.groupBy({
      by: ["status"],
      _count: { _all: true },
    });

    const counts: Record<string, number> = {
      processing: 0,
      processed: 0,
      failed: 0,
      dead_letter: 0,
    };
    for (const row of grouped) counts[row.status] = row._count._all;

    // Evento pendente mais antigo (failed ou processing preso): sinal de worker
    // parado. Buscamos só o createdAt do mais antigo.
    const oldestPending = await prisma.webhookEvent.findFirst({
      where: {
        OR: [
          { status: WebhookStatus.failed },
          {
            status: WebhookStatus.processing,
            updatedAt: { lt: staleThreshold },
          },
        ],
      },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });

    const oldestPendingAgeMs = oldestPending
      ? now - oldestPending.createdAt.getTime()
      : 0;

    // Deriva o status de saúde.
    let status: Health = "healthy";
    const reasons: string[] = [];

    if (counts.dead_letter > 0) {
      status = "unhealthy";
      reasons.push(`${counts.dead_letter} evento(s) em dead_letter`);
    }
    if (counts.failed >= FAILED_BACKLOG_DEGRADED) {
      if (status !== "unhealthy") status = "degraded";
      reasons.push(`backlog de ${counts.failed} falhas`);
    }
    if (oldestPendingAgeMs > OLDEST_PENDING_DEGRADED_MS) {
      if (status !== "unhealthy") status = "degraded";
      reasons.push(
        `evento pendente há ${Math.round(oldestPendingAgeMs / 3_600_000)}h (worker parado?)`
      );
    }

    const body = {
      status,
      reasons,
      counts,
      oldestPendingAgeMs,
      checkedAt: new Date(now).toISOString(),
    };

    // HTTP 503 quando unhealthy: permite que monitores que só olham o status
    // code (sem parsear o corpo) também disparem alarme.
    const httpStatus = status === "unhealthy" ? 503 : 200;
    return NextResponse.json(body, { status: httpStatus });
  } catch (err) {
    log.error("health.check_failed", { ...serializeError(err) });
    // Falha ao computar a própria saúde também é um sinal: 503.
    return NextResponse.json(
      { status: "unhealthy", reasons: ["health check falhou"] },
      { status: 503 }
    );
  }
}
