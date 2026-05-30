import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  // Roda em todas as rotas exceto estáticos e a própria API de auth
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
};
