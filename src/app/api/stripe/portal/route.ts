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
      select: { stripeCustomerId: true },
    });
    if (!user?.stripeCustomerId) {
      return NextResponse.json({ error: "Sem cliente Stripe" }, { status: 400 });
    }

    const portal = await withTimeout(
      stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
      }),
      8_000,
      "billingPortal.sessions.create"
    );

    return NextResponse.json({ url: portal.url });
  } catch (err) {
    log.error("portal.failed", {
      requestId,
      userEmail: session.user.email,
      ...serializeError(err),
    });
    return NextResponse.json(
      { error: "Não foi possível abrir o portal" },
      { status: 502 }
    );
  }
}
