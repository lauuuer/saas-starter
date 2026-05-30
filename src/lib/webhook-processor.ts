import type Stripe from "stripe";
import { syncSubscription, retrieveSubscription } from "@/lib/subscription";

// Eventos que efetivamente alteram estado de billing neste app.
// Qualquer outro é registrado e ignorado (2xx) sem processamento.
export const HANDLED_EVENTS = new Set<string>([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
]);

/**
 * Executa o efeito de negócio de um evento já verificado.
 * Lança em caso de falha — quem chama decide o estado e a resposta/retry.
 *
 * Compartilhado entre o handler de webhook (caminho síncrono) e o worker de
 * reprocessamento (caminho assíncrono), garantindo lógica única.
 */
export async function processEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === "subscription" && session.subscription) {
        const sub = await retrieveSubscription(session.subscription as string);
        await syncSubscription(sub, session.metadata?.userId);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      await syncSubscription(sub, sub.metadata?.userId);
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      if (invoice.subscription) {
        const sub = await retrieveSubscription(invoice.subscription as string);
        await syncSubscription(sub, sub.metadata?.userId);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Reconstrói o objeto Stripe.Event a partir do payload cru persistido.
 * Usado pelo worker: o evento já passou pela verificação de assinatura quando
 * foi recebido, então aqui apenas desserializamos com segurança de tipo.
 */
export function parseStoredEvent(payload: string): Stripe.Event {
  return JSON.parse(payload) as Stripe.Event;
}
