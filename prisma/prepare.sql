-- Runs before `prisma db push` on deploy.
--
-- SignalState is a disposable cache of the last observed verdict per symbol; it
-- is rebuilt by the next signals poll. It has to be empty because the per-user
-- schema changes its primary key (symbol -> id + unique(userId, symbol)), and
-- `db push` cannot invent client-generated ids for existing rows.
--
-- Safe on a fresh database too: the statement is wrapped with `|| true` in the
-- build command.
DELETE FROM "SignalState";
