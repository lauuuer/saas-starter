import { auth, signOut } from "@/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getActiveSubscription } from "@/lib/billing";
import { PortalButton } from "@/components/PortalButton";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");

  const subscription = await getActiveSubscription(session.user.email);

  return (
    <main className="min-h-screen px-6 py-12 max-w-3xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-sm text-neutral-400">Bem-vindo,</p>
          <h1 className="text-2xl font-bold">{session.user.name}</h1>
        </div>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
        >
          <button className="text-sm text-neutral-400 hover:text-white transition">
            Sair
          </button>
        </form>
      </header>

      <section className="mt-12">
        {subscription ? (
          <div className="rounded-xl border border-[var(--accent)]/40 bg-[var(--accent)]/5 p-8">
            <span className="text-xs uppercase tracking-widest text-[var(--accent)]">
              Plano Pro ativo
            </span>
            <h2 className="mt-2 text-xl font-bold">Conteúdo premium liberado 🎉</h2>
            <p className="mt-2 text-sm text-neutral-400">
              {subscription.currentPeriodEnd
                ? `${subscription.cancelAtPeriodEnd ? "Acesso até" : "Renova em"} ${subscription.currentPeriodEnd.toLocaleDateString("pt-BR")}.`
                : "Assinatura ativa."}
              {subscription.cancelAtPeriodEnd && " (cancelamento agendado)"}
            </p>
            <div className="mt-6">
              <PortalButton />
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-neutral-800 p-8">
            <h2 className="text-xl font-bold">Você ainda não tem o plano Pro</h2>
            <p className="mt-2 text-sm text-neutral-400">
              Assine para desbloquear o conteúdo premium.
            </p>
            <Link
              href="/pricing"
              className="mt-6 inline-block rounded-md bg-[var(--accent)] px-6 py-3 font-medium text-black hover:opacity-90 transition"
            >
              Ver planos
            </Link>
          </div>
        )}
      </section>
    </main>
  );
}
