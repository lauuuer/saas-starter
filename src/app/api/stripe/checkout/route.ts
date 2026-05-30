import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { log, serializeError } from "@/lib/logger";
import { withTimeout } from "@/lib/subscription";

export const runtime = "nodejs";

export async function POST() {
  const requestId = crypto.randomUUID();

  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: { id: true, email: true, stripeCustomerId: true },
    });
    if (!user) {
      return NextResponse.json(
        { error: "Usuário não encontrado" },
        { status: 404 }
      );
    }

    // Reutiliza ou cria o Customer do Stripe.
    // Race resolvida: dois checkouts concorrentes do mesmo user usariam a MESMA
    // idempotencyKey (derivada do userId), então o Stripe retorna o MESMO customer
    // em vez de criar dois. Elimina o customer órfão do dual-write.
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await withTimeout(
        stripe.customers.create(
          {
            email: user.email!,
            metadata: { userId: user.id },
          },
          { idempotencyKey: `customer_create_${user.id}` }
        ),
        8_000,
        "customers.create"
      );
      customerId = customer.id;
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId: customerId },
      });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
    const checkout = await withTimeout(
      stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: process.env.STRIPE_PRICE_ID!, quantity: 1 }],
        success_url: `${appUrl}/dashboard?checkout=success`,
        cancel_url: `${appUrl}/pricing?checkout=cancelled`,
        metadata: { userId: user.id },
        // Propaga o userId para a PRÓPRIA subscription. Assim os eventos
        // customer.subscription.* trazem metadata.userId no payload, permitindo
        // reconciliação no webhook mesmo sem depender do stripeCustomerId.
        subscription_data: { metadata: { userId: user.id } },
      }),
      8_000,
      "checkout.sessions.create"
    );

    if (!checkout.url) {
      throw new Error("Checkout session sem URL");
    }
    return NextResponse.json({ url: checkout.url });
  } catch (err) {
    log.error("checkout.failed", {
      requestId,
      userEmail: session.user.email,
      ...serializeError(err),
    });
    return NextResponse.json(
      { error: "Não foi possível iniciar o checkout" },
      { status: 502 }
    );
  }
}
