import { auth } from "@/auth";
import Link from "next/link";
import { CheckoutButton } from "@/components/CheckoutButton";

export default async function PricingPage() {
  const session = await auth();

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6">
      <h1 className="text-4xl font-bold">Pro Plan</h1>
      <p className="mt-3 text-neutral-400">Full access to premium content.</p>

      <div className="mt-10 w-full max-w-sm rounded-xl border border-neutral-800 p-8">
        <div className="flex items-baseline gap-1">
          <span className="text-4xl font-bold">$29</span>
          <span className="text-neutral-400">/month</span>
        </div>
        <ul className="mt-6 space-y-2 text-sm text-neutral-300">
          <li>✓ Premium dashboard</li>
          <li>✓ Priority support</li>
          <li>✓ Cancel anytime</li>
        </ul>
        <div className="mt-8">
          {session?.user ? (
            <CheckoutButton />
          ) : (
            <Link
              href="/login"
              className="inline-block rounded-md bg-[var(--accent)] px-6 py-3 font-medium text-black hover:opacity-90 transition"
            >
              Sign in to subscribe
            </Link>
          )}
        </div>
      </div>
    </main>
  );
}
