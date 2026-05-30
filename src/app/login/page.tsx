import { signIn, auth } from "@/auth";
import { redirect } from "next/navigation";

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-xl border border-neutral-800 p-8">
        <h1 className="text-2xl font-bold">Entrar</h1>
        <p className="mt-2 text-sm text-neutral-400">
          Use sua conta do GitHub para continuar.
        </p>
        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/dashboard" });
          }}
        >
          <button
            type="submit"
            className="mt-6 w-full rounded-md bg-[var(--fg)] px-4 py-3 font-medium text-black hover:opacity-90 transition"
          >
            Continuar com GitHub
          </button>
        </form>
      </div>
    </main>
  );
}
