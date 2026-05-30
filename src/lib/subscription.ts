import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { SubscriptionStatus } from "@prisma/client";

// Timeout padrão para chamadas à API do Stripe feitas dentro do request.
// Sem isso, o handler fica refém da latência da dependência (retry storm).
const STRIPE_TIMEOUT_MS = 8_000;

/**
 * Envolve uma promise com timeout. Em caso de estouro, rejeita explicitamente
 * em vez de deixar a chamada pendurada indefinidamente.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms = STRIPE_TIMEOUT_MS,
  label = "operation"
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timeout (${ms}ms) em ${label}`)),
      ms
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// Mapa explícito Stripe -> nosso enum. Status fora do mapa é tratado como erro,
// não silenciado com `as any` (que deixaria entrar lixo no banco).
const STATUS_MAP: Record<string, SubscriptionStatus> = {
  active: SubscriptionStatus.active,
  trialing: SubscriptionStatus.trialing,
  past_due: SubscriptionStatus.past_due,
  canceled: SubscriptionStatus.canceled,
  incomplete: SubscriptionStatus.incomplete,
  incomplete_expired: SubscriptionStatus.canceled,
  unpaid: SubscriptionStatus.unpaid,
  paused: SubscriptionStatus.canceled,
};

function mapStatus(stripeStatus: string): SubscriptionStatus {
  const mapped = STATUS_MAP[stripeStatus];
  if (!mapped) {
    // Falha alto e claro: um status novo do Stripe não deve virar dado inválido.
    throw new Error(`Status de subscription desconhecido: ${stripeStatus}`);
  }
  return mapped;
}

/**
 * Converte um epoch (segundos) do Stripe em Date, tolerando ausência.
 * Alguns estados (ex.: incomplete) podem não trazer o campo.
 */
function toDate(epochSeconds: number | null | undefined): Date | null {
  if (epochSeconds == null || Number.isNaN(epochSeconds)) return null;
  return new Date(epochSeconds * 1000);
}

/**
 * Extrai current_period_end de forma compatível com Acacia e Basil.
 *
 * A partir da API Basil (2025-03-31), o Stripe REMOVEU current_period_end do
 * nível da Subscription e moveu para CADA item (items.data[].current_period_end).
 * Código que lê o campo top-level recebe `undefined` silenciosamente após a
 * migração — e, em billing, isso significa negar acesso a quem pagou.
 *
 * Estratégia: tenta o item-level primeiro (Basil); cai para o top-level (Acacia).
 * Em subscriptions com múltiplos itens (intervalos mistos), usa o MENOR período
 * — conservador: o acesso reflete o item que expira primeiro.
 */
function extractCurrentPeriodEnd(sub: Stripe.Subscription): number | null {
  const itemEnds = sub.items?.data
    ?.map((item) => (item as { current_period_end?: number }).current_period_end)
    .filter((v): v is number => typeof v === "number");

  if (itemEnds && itemEnds.length > 0) {
    return Math.min(...itemEnds);
  }

  // Fallback Acacia (campo top-level ainda presente em versões < Basil).
  const topLevel = (sub as { current_period_end?: number }).current_period_end;
  return typeof topLevel === "number" ? topLevel : null;
}

/**
 * Sincroniza o estado de uma subscription do Stripe para o nosso banco.
 * Idempotente por natureza (upsert converge para o mesmo estado).
 *
 * Recebe o objeto Subscription já resolvido — quem chama decide se ele veio
 * do payload (sem custo de rede) ou de um retrieve (com custo).
 *
 * @param fallbackUserId userId vindo do metadata do evento, usado para
 *   reconciliar quando o stripeCustomerId ainda não está gravado no nosso DB
 *   (ex.: corrida na criação do customer). Evita "perder" uma subscription paga.
 */
export async function syncSubscription(
  sub: Stripe.Subscription,
  fallbackUserId?: string
): Promise<void> {
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  // Reconciliação: primeiro pelo customerId; se não achar, pelo userId do
  // metadata; e nesse caso, grava o customerId que faltava (self-healing).
  let user = await prisma.user.findUnique({
    where: { stripeCustomerId: customerId },
    select: { id: true },
  });

  if (!user && fallbackUserId) {
    user = await prisma.user.findUnique({
      where: { id: fallbackUserId },
      select: { id: true },
    });
    if (user) {
      // Repara o vínculo que deveria ter sido gravado no checkout.
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId: customerId },
      });
    }
  }

  // Customer desconhecido E sem fallback: ignora com segurança (ex.: eventos
  // de teste ou customers criados fora deste app). Não é erro.
  if (!user) return;

  const priceId = sub.items.data[0]?.price.id;
  if (!priceId) {
    throw new Error(`Subscription ${sub.id} sem price item`);
  }

  const data = {
    stripeSubscriptionId: sub.id,
    stripePriceId: priceId,
    status: mapStatus(sub.status),
    currentPeriodEnd: toDate(extractCurrentPeriodEnd(sub)),
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
  };

  await prisma.subscription.upsert({
    where: { userId: user.id },
    create: { userId: user.id, ...data },
    update: data,
  });
}

/**
 * Resolve o objeto Subscription a partir de um id, com timeout.
 * Usado apenas quando o payload não traz a subscription embutida
 * (ex.: checkout.session.completed, invoice.payment_failed).
 */
export async function retrieveSubscription(
  subscriptionId: string
): Promise<Stripe.Subscription> {
  return withTimeout(
    stripe.subscriptions.retrieve(subscriptionId),
    STRIPE_TIMEOUT_MS,
    `subscriptions.retrieve(${subscriptionId})`
  );
}
