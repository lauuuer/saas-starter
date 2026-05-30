import type { NextAuthConfig } from "next-auth";
import GitHub from "next-auth/providers/github";

// Config compartilhada e compatível com o Edge runtime (sem o adapter Prisma).
// O middleware importa apenas esta parte.
export const authConfig = {
  providers: [GitHub],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    // Protege rotas: só usuários logados acessam /dashboard
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isOnDashboard = nextUrl.pathname.startsWith("/dashboard");
      if (isOnDashboard) return isLoggedIn;
      return true;
    },
  },
} satisfies NextAuthConfig;
