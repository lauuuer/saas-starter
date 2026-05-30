import { prisma } from "@/lib/prisma";
import { SubscriptionStatus, type Subscription } from "@prisma/client";

const ACTIVE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.active,
  SubscriptionStatus.trialing,
];

/**
 * Retorna a subscription se o usuário tem acesso premium ATIVO no momento.
 *
 * Regras:
 *  - status deve ser active ou trialing;
 *  - se currentPeriodEnd existir, deve estar no futuro (acesso até o fim do período
 *    pago, inclusive quando cancelAtPeriodEnd = true);
 *  - currentPeriodEnd nulo (estado transitório) é tratado como SEM acesso, de forma
 *    conservadora — melhor negar e deixar o webhook reconciliar do que liberar indevido.
 */
export async function getActiveSubscription(
  userEmail: string
): Promise<Subscription | null> {
  const user = await prisma.user.findUnique({
    where: { email: userEmail },
    select: { subscription: true },
  });

  const sub = user?.subscription;
  if (!sub) return null;

  if (!ACTIVE_STATUSES.includes(sub.status)) return null;
  if (!sub.currentPeriodEnd) return null;
  if (sub.currentPeriodEnd.getTime() <= Date.now()) return null;

  return sub;
}
