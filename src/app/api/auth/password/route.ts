import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  SESSION_COOKIE,
  createSessionToken,
  getSessionUser,
  hashPassword,
  sessionCookieOptions,
  verifyPassword,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(8, "Use at least 8 characters").max(200),
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: "New password must be different from the current one",
    path: ["newPassword"],
  });

/**
 * POST /api/auth/password — change the signed-in account's password.
 *
 * Requires the current password (so a stolen cookie alone cannot lock the owner
 * out), then re-issues the session cookie. The session token only carries the
 * user id, so it would remain valid anyway; re-issuing keeps the 30-day window
 * rolling after a deliberate security action.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const record = await db.user.findUnique({
    where: { id: user.id },
    select: { id: true, passwordHash: true },
  });
  if (!record) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  if (!verifyPassword(parsed.data.currentPassword, record.passwordHash)) {
    return NextResponse.json({ error: "Current password is incorrect" }, { status: 401 });
  }

  await db.user.update({
    where: { id: record.id },
    data: { passwordHash: hashPassword(parsed.data.newPassword) },
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, createSessionToken(record.id), sessionCookieOptions);

  return NextResponse.json({ ok: true });
}
