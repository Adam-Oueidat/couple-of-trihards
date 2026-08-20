/**
 * One-way refresh: copies the remote Turso database down into a local SQLite
 * file. Never writes upstream, so it cannot clobber production.
 *
 * Usage:  pnpm db:pull-prod [destination-file]
 *
 * Reads TURSO_DATABASE_URL / TURSO_AUTH_TOKEN from the environment, falling
 * back to apps/web/.env.local so it works without exporting anything.
 */
import { existsSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import { createLogger } from "@trihards/core";

const log = createLogger("db:pull-prod");

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const ENV_FILE = resolve(REPO_ROOT, "apps/web/.env.local");
const DEFAULT_DEST = resolve(REPO_ROOT, "apps/web/.data/local.db");
const BATCH = 500;

/** Fill in missing vars from .env.local; already-set env always wins. */
function loadEnvFallback(): void {
  if (!existsSync(ENV_FILE)) return;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.trim().replace(/^["']|["']$/g, "");
  }
}

async function main() {
  loadEnvFallback();

  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL is not set");
  if (url.startsWith("file:")) {
    throw new Error(
      `refusing to pull: TURSO_DATABASE_URL is a local file (${url}). ` +
        "Point it at the remote Turso database.",
    );
  }

  const dest = resolve(process.argv[2] ?? DEFAULT_DEST);
  const remote = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

  // Move any existing file aside rather than merging into it, so the result is
  // always an exact mirror of upstream.
  if (existsSync(dest)) {
    const backup = `${dest}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    renameSync(dest, backup);
    log.info("moved existing database aside", { backup });
  }
  const local = createClient({ url: `file:${dest}` });

  // Tables first, then indexes/triggers/views, so DDL never references a
  // missing table. FK enforcement is off because rows arrive table-by-table.
  const schema = await remote.execute(
    `select type, name, sql from sqlite_master
      where sql is not null and name not like 'sqlite_%'
      order by case type when 'table' then 0 else 1 end, name`,
  );
  await local.execute("PRAGMA foreign_keys=OFF");

  const tables: string[] = [];
  for (const row of schema.rows) {
    const type = String(row.type);
    await local.execute(String(row.sql));
    if (type === "table") tables.push(String(row.name));
  }
  log.info("schema copied", { objects: schema.rows.length, tables: tables.length });

  let total = 0;
  for (const table of tables) {
    const data = await remote.execute(`select * from "${table}"`);
    if (data.rows.length === 0) continue;

    const cols = data.columns;
    const colList = cols.map((c) => `"${c}"`).join(", ");
    const placeholders = cols.map(() => "?").join(", ");
    const sql = `insert into "${table}" (${colList}) values (${placeholders})`;

    for (let i = 0; i < data.rows.length; i += BATCH) {
      await local.batch(
        data.rows.slice(i, i + BATCH).map((row) => ({
          sql,
          args: cols.map((c) => (row as Record<string, unknown>)[c] ?? null),
        })),
        "write",
      );
    }
    total += data.rows.length;
    log.info("copied table", { table, rows: data.rows.length });
  }

  remote.close();
  local.close();
  log.info("pull complete", { dest, tables: tables.length, rows: total });
}

main().catch((err) => {
  log.error("pull failed", err);
  process.exit(1);
});
