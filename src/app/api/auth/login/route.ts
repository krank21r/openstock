import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  SESSION_COOKIE,
  createSessionToken,
  sessionCookieOptions,
  verifyPassword,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

const schema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});

/** POST /api/auth/login — credentials in, signed session cookie out. */
export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Username and password required" }, { status: 400 });
  }

  const username = parsed.data.username.toLowerCase();
  const user = await db.user.findUnique({ where: { username } });

  if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
    return NextResponse.json({ error: "Wrong username or password" }, { status: 401 });
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, createSessionToken(user.id), sessionCookieOptions);

  return NextResponse.json({ user: { id: user.id, username: user.username } });
}
