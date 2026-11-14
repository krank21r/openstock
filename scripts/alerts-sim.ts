/**
 * Test helper for the Trade Alerts feature.
 *
 *   bun scripts/alerts-sim.ts seed [SYMBOL] [USERNAME]  — force SignalState(verdict=Neutral)
 *                                                         so the next poll fires a transition
 *   bun scripts/alerts-sim.ts reset [USERNAME]          — clear that account's alerts + states
 *
 * Without a username the first account is used.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const cmd = process.argv[2] ?? "seed";
const symbol = (process.argv[3] ?? "AAPL").toUpperCase();
const usernameArg = process.argv[4]?.toLowerCase();

async function resolveUser() {
  const user = usernameArg
    ? await db.user.findUnique({ where: { username: usernameArg } })
    : await db.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!user) throw new Error("No account found — run scripts/create-users.ts first.");
  return user;
}

async function main() {
  const user = await resolveUser();

  if (cmd === "seed") {
    await db.signalState.upsert({
      where: { userId_symbol: { userId: user.id, symbol } },
      create: { userId: user.id, symbol, verdict: "Neutral" },
      update: { verdict: "Neutral" },
    });
    console.log(
      `seeded SignalState ${symbol} = Neutral for ${user.username} (next poll should create an alert)`,
    );
  } else if (cmd === "reset") {
    await db.signalAlert.deleteMany({ where: { userId: user.id } });
    await db.signalState.deleteMany({ where: { userId: user.id } });
    console.log(`cleared alerts + signal states for ${user.username}`);
  } else {
    console.error(`Unknown command "${cmd}" — use "seed" or "reset".`);
    process.exitCode = 1;
  }

  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await db.$disconnect();
  process.exit(1);
});
