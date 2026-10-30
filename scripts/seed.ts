import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const DEFAULTS = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL"];

async function main() {
  for (const symbol of DEFAULTS) {
    await db.watchlistItem.upsert({ where: { symbol }, update: {}, create: { symbol } });
  }
  console.log("watchlist seeded, rows:", await db.watchlistItem.count());
  await db.$disconnect();
}
main();
