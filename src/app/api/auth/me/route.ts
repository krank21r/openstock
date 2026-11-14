import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** GET /api/auth/me — the signed-in account, or null. */
export async function GET() {
  const user = await getSessionUser();
  return NextResponse.json({ user });
}
