/**
 * Create the app's user accounts directly in the database.
 *
 *   bun scripts/create-users.ts                 # two accounts, generated passwords
 *   bun scripts/create-users.ts alice bob       # custom usernames
 *   bun scripts/create-users.ts alice:s3cret …  # explicit passwords
 *
 * Rows that predate accounts (userId = null) are adopted by the first account,
 * so an existing watchlist / alerts / trades stay visible instead of vanishing.
 *
 * On Vercel you cannot run this — use POST /api/auth/bootstrap once instead.
 */

import { PrismaClient } from "@prisma/client";
import { generatePassword, hashPassword } from "../src/lib/password";

const db = new PrismaClient();

const DEFAULT_NAMES = ["trader1", "trader2"];

async function main() {
  const args = process.argv.slice(2);

  const specs = (args.length > 0 ? args : DEFAULT_NAMES).map((raw) => {
    const [name, password] = raw.split(":");
    return {
      username: name.trim().toLowerCase(),
      password: password?.trim() || generatePassword(),
    };
  });

  const created: { username: string; password: string; existed: boolean }[] = [];

  for (const spec of specs) {
    const existing = await db.user.findUnique({ where: { username: spec.username } });
    if (existing) {
      await db.user.update({
        where: { username: spec.username },
        data: { passwordHash: hashPassword(spec.password) },
      });
      created.push({ ...spec, existed: true });
    } else {
      await db.user.create({
        data: { username: spec.username, passwordHash: hashPassword(spec.password) },
      });
      created.push({ ...spec, existed: false });
    }
  }

  const owner = await db.user.findUnique({
    where: { username: created[0].username },
    select: { id: true },
  });

  const [watchlist, states, alerts, trades] = owner
    ? await Promise.all([
        db.watchlistItem.updateMany({ where: { userId: null }, data: { userId: owner.id } }),
        db.signalState.updateMany({ where: { userId: null }, data: { userId: owner.id } }),
        db.signalAlert.updateMany({ where: { userId: null }, data: { userId: owner.id } }),
        db.trackedTrade.updateMany({ where: { userId: null }, data: { userId: owner.id } }),
      ])
    : [{ count: 0 }, { count: 0 }, { count: 0 }, { count: 0 }];

  console.log("accounts:");
  for (const u of created) {
    console.log(
      `  ${u.username.padEnd(12)} ${u.password.padEnd(18)} ${u.existed ? "(password reset)" : "(created)"}`,
    );
  }
  console.log(
    `legacy rows adopted into ${created[0].username}: watchlist=${watchlist.count} states=${states.count} alerts=${alerts.count} trades=${trades.count}`,
  );

  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
