import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
      <span className="text-sm tracking-[0.3em] uppercase text-[var(--accent)]">
        SaaS Starter
      </span>
      <h1 className="mt-4 text-5xl font-bold max-w-2xl leading-tight">
        Assinaturas com auth, pagamentos e webhooks de verdade.
      </h1>
      <p className="mt-6 max-w-xl text-neutral-400">
        NextAuth + Prisma + Stripe. Fluxo completo de SaaS com verificação de
        assinatura e idempotência — o que a maioria dos portfólios erra.
      </p>
      <div className="mt-10 flex gap-4">
        <Link
          href="/pricing"
          className="rounded-md bg-[var(--accent)] px-6 py-3 font-medium text-black hover:opacity-90 transition"
        >
          Ver planos
        </Link>
        <Link
          href="/dashboard"
          className="rounded-md border border-neutral-700 px-6 py-3 font-medium hover:border-neutral-500 transition"
        >
          Dashboard
        </Link>
      </div>
    </main>
  );
}
