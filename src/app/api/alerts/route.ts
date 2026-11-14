import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/alerts — list this account's signal-transition alerts (newest first).
 * DISMISSED rows are hidden; STALE/TAKEN are returned so the UI can show
 * "signal faded" and "tracked in My Trades" states.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  try {
    const alerts = await db.signalAlert.findMany({
      where: { userId: user.id, status: { not: "DISMISSED" } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return NextResponse.json({ alerts });
  } catch (err) {
    console.error("GET /api/alerts error:", err);
    return NextResponse.json({ error: "Failed to load alerts" }, { status: 500 });
  }
}

/** POST /api/alerts — dismiss an alert (soft delete). Body: { id }. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  try {
    const body = await req.json().catch(() => null);
    const parsed = z.object({ id: z.string().trim().min(1) }).safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    // Ownership is part of the lookup — another account's id is a 404.
    const existing = await db.signalAlert.findFirst({
      where: { id: parsed.data.id, userId: user.id },
    });
    if (!existing) {
      return NextResponse.json({ error: "Alert not found" }, { status: 404 });
    }
    await db.signalAlert.update({
      where: { id: parsed.data.id },
      data: { status: "DISMISSED" },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("POST /api/alerts error:", err);
    return NextResponse.json({ error: "Failed to dismiss alert" }, { status: 500 });
  }
}
