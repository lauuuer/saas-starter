// Política de retry compartilhada entre o handler de webhook e o worker.
// Centralizar evita divergência de comportamento entre os dois caminhos.

// Teto de tentativas antes de mover para dead_letter (intervenção manual).
export const MAX_ATTEMPTS = 8;

// Janela após a qual um evento "processing" é considerado preso (a invocação
// que o reivindicou morreu sem finalizar). Deve ser > timeout de processamento.
export const STALE_PROCESSING_MS = 30_000;

/**
 * Backoff exponencial com teto e jitter.
 * jitter evita "thundering herd": vários eventos que falharam ao mesmo tempo
 * (ex.: Stripe fora do ar) não voltam todos no mesmo instante.
 */
export function computeBackoffMs(attempts: number): number {
  const base = 1_000; // 1s
  const cap = 60 * 60 * 1_000; // 1h
  const exponential = Math.min(cap, base * 2 ** Math.max(0, attempts - 1));
  const jitter = Math.random() * exponential * 0.2; // até 20% de jitter
  return Math.floor(exponential + jitter);
}

/**
 * Decide o desfecho de uma falha de processamento, de forma única para o
 * handler do webhook e o worker. Retorna o patch a aplicar no WebhookEvent.
 *
 * Regra central: ao exceder MAX_ATTEMPTS, o evento vira `dead_letter` (terminal)
 * em vez de continuar sendo reprocessado a cada reentrega do Stripe (que insiste
 * por até 3 dias). Isso evita reprocessamento determinístico-falho em loop.
 */
export function decideFailureOutcome(
  attempts: number,
  errorMessage: string,
  now: Date = new Date()
): {
  isDeadLetter: boolean;
  data: {
    status: "failed" | "dead_letter";
    lastError: string;
    nextRetryAt: Date | null;
  };
} {
  if (attempts >= MAX_ATTEMPTS) {
    return {
      isDeadLetter: true,
      data: { status: "dead_letter", lastError: errorMessage, nextRetryAt: null },
    };
  }
  return {
    isDeadLetter: false,
    data: {
      status: "failed",
      lastError: errorMessage,
      nextRetryAt: new Date(now.getTime() + computeBackoffMs(attempts)),
    },
  };
}
