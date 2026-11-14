/**
 * Seed the default watchlist for an account.
 *
 *   bun scripts/seed.ts [username]     # defaults to the first account
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const DEFAULTS = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL"];

async function main() {
  const username = process.argv[2]?.toLowerCase();
  const user = username
    ? await db.user.findUnique({ where: { username } })
    : await db.user.findFirst({ orderBy: { createdAt: "asc" } });

  if (!user) {
    console.error("No account found — run scripts/create-users.ts first.");
    await db.$disconnect();
    process.exit(1);
  }

  for (const symbol of DEFAULTS) {
    await db.watchlistItem.upsert({
      where: { userId_symbol: { userId: user.id, symbol } },
      update: {},
      create: { userId: user.id, symbol },
    });
  }
  console.log(
    `watchlist seeded for ${user.username}, rows:`,
    await db.watchlistItem.count({ where: { userId: user.id } }),
  );
  await db.$disconnect();
}

main();
