import { auth } from "@/auth";
import Link from "next/link";
import { CheckoutButton } from "@/components/CheckoutButton";

export default async function PricingPage() {
  const session = await auth();

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6">
      <h1 className="text-4xl font-bold">Plano Pro</h1>
      <p className="mt-3 text-neutral-400">Acesso completo ao conteúdo premium.</p>

      <div className="mt-10 w-full max-w-sm rounded-xl border border-neutral-800 p-8">
        <div className="flex items-baseline gap-1">
          <span className="text-4xl font-bold">R$29</span>
          <span className="text-neutral-400">/mês</span>
        </div>
        <ul className="mt-6 space-y-2 text-sm text-neutral-300">
          <li>✓ Dashboard premium</li>
          <li>✓ Suporte prioritário</li>
          <li>✓ Cancele quando quiser</li>
        </ul>
        <div className="mt-8">
          {session?.user ? (
            <CheckoutButton />
          ) : (
            <Link
              href="/login"
              className="inline-block rounded-md bg-[var(--accent)] px-6 py-3 font-medium text-black hover:opacity-90 transition"
            >
              Entrar para assinar
            </Link>
          )}
        </div>
      </div>
    </main>
  );
}
