import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@libsql/client";
import { makeDb, type Db } from "../src/client";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export async function makeTestDb(): Promise<{ db: Db; client: Client }> {
  const { db, client } = makeDb(":memory:");
  await applyMigrations(client);
  return { db, client };
}

async function applyMigrations(client: Client): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await client.execute(stmt);
    }
  }
}
