/**
 * Auth for the background sweep endpoint (`/api/cron/alerts`).
 *
 * Kept dependency-free so the rule can be unit-tested outside Next.js.
 *
 * Behaviour:
 *  - No `CRON_SECRET` configured  -> `configured = false`, requests are allowed
 *    (the app works out of the box; the endpoint is idempotent and bounded).
 *  - `CRON_SECRET` configured     -> the secret must arrive as either
 *    `Authorization: Bearer <secret>` (Vercel Cron sends this automatically)
 *    or `?key=<secret>` (GitHub Actions, cron-job.org, curl).
 */

export interface CronAuthInput {
  authorization: string | null;
  key: string | null;
}

export function isCronAuthorized(
  input: CronAuthInput,
  secret = process.env.CRON_SECRET,
): boolean {
  const expected = secret?.trim();
  if (!expected) return true; // nothing configured — stay permissive

  const bearer = input.authorization?.trim() ?? "";
  if (bearer === `Bearer ${expected}`) return true;

  return input.key?.trim() === expected;
}
