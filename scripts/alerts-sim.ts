/**
 * Test helper for the Trade Alerts feature.
 *
 *   bun scripts/alerts-sim.ts seed [SYMBOL]   — force SignalState(verdict=Neutral) so the
 *                                               next signals poll creates a transition alert
 *   bun scripts/alerts-sim.ts reset           — clear all alerts + signal states (fresh start)
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const cmd = process.argv[2] ?? "seed";
const symbol = (process.argv[3] ?? "AAPL").toUpperCase();

async function main() {
  if (cmd === "seed") {
    await db.signalState.upsert({
      where: { symbol },
      create: { symbol, verdict: "Neutral" },
      update: { verdict: "Neutral" },
    });
    console.log(`seeded SignalState ${symbol} = Neutral (next poll should create an alert)`);
  } else if (cmd === "reset") {
    await db.signalAlert.deleteMany({});
    await db.signalState.deleteMany({});
    console.log("cleared all SignalAlert + SignalState rows");
  } else {
    console.log("unknown command:", cmd);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
