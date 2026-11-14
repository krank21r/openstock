import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";

export const dynamic = "force-dynamic";

const schema = z.object({
  users: z
    .array(
      z.object({
        username: z
          .string()
          .trim()
          .min(3)
          .max(32)
          .regex(/^[a-zA-Z0-9_.-]+$/, "letters, digits, dot, dash, underscore only"),
        password: z.string().min(8).max(200),
      }),
    )
    .min(1)
    .max(20),
});

/**
 * POST /api/auth/bootstrap — one-time account creation.
 *
 * Only works while the User table is empty, so it can be called on a fresh
 * deployment and then becomes dead weight (409 forever after). Existing rows
 * created before accounts existed (userId = null) are adopted by the first
 * account so no history is lost.
 */
export async function POST(req: NextRequest) {
  const existing = await db.user.count();
  if (existing > 0) {
    return NextResponse.json(
      { error: "Already initialised", users: existing },
      { status: 409 },
    );
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", detail: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }

  const created: { id: string; username: string }[] = [];
  for (const spec of parsed.data.users) {
    const username = spec.username.toLowerCase();
    const user = await db.user.create({
      data: { username, passwordHash: hashPassword(spec.password) },
      select: { id: true, username: true },
    });
    created.push(user);
  }

  // Adopt pre-account data into the first account.
  const owner = created[0].id;
  const [watchlist, states, alerts, trades] = await Promise.all([
    db.watchlistItem.updateMany({ where: { userId: null }, data: { userId: owner } }),
    db.signalState.updateMany({ where: { userId: null }, data: { userId: owner } }),
    db.signalAlert.updateMany({ where: { userId: null }, data: { userId: owner } }),
    db.trackedTrade.updateMany({ where: { userId: null }, data: { userId: owner } }),
  ]);

  return NextResponse.json(
    {
      ok: true,
      users: created,
      adopted: {
        watchlist: watchlist.count,
        states: states.count,
        alerts: alerts.count,
        trades: trades.count,
      },
    },
    { status: 201 },
  );
}
