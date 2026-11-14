/**
 * Accounts and sessions — deliberately dependency-free.
 *
 * Passwords: scrypt with a per-user random salt (node:crypto).
 * Sessions: a signed, stateless cookie — base64url payload + HMAC-SHA256, no
 * next-auth needed (v4 does not support the Next 16 App Router cleanly).
 *
 * Set AUTH_SECRET in the environment for production. Without it a development
 * fallback is used, which is fine locally but must not be trusted publicly.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";

export { hashPassword, verifyPassword, generatePassword } from "@/lib/password";

export const SESSION_COOKIE = "openstock_session";
const SESSION_DAYS = 30;

function sessionSecret(): string {
  const explicit = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (explicit) return explicit;

  // No dedicated secret configured (e.g. a fresh Vercel project): derive one
  // from DATABASE_URL. It is server-only, unique per deployment and never in
  // the repository, so a cookie cannot be forged from public source. Set
  // AUTH_SECRET anyway if you want to rotate sessions independently of the DB.
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) return createHash("sha256").update(`openstock-session:${dbUrl}`).digest("hex");

  return "openstock-dev-only-secret-do-not-ship";
}

// ------------------------------ passwords ------------------------------
// (implemented in lib/password.ts and re-exported above)

// ------------------------------ sessions ------------------------------

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

export function createSessionToken(userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, exp: Date.now() + SESSION_DAYS * 86_400_000 }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readSessionToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.sub !== "string" || typeof parsed.exp !== "number") return null;
    if (parsed.exp < Date.now()) return null;
    return parsed.sub;
  } catch {
    return null;
  }
}

// ------------------------------ helpers ------------------------------

export interface SessionUser {
  id: string;
  username: string;
}

/** Current user from the request cookie, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  let userId: string | null = null;
  try {
    const store = await cookies();
    userId = readSessionToken(store.get(SESSION_COOKIE)?.value);
  } catch {
    return null; // not in a request scope
  }
  if (!userId) return null;

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true },
  });
  return user ?? null;
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_DAYS * 86_400,
};
