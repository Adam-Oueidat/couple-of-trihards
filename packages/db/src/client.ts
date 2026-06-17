import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

let cached: { client: Client; db: Db } | null = null;

export function getDb(): Db {
  if (cached) return cached.db;
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL is not set");
  const client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  const db = drizzle(client, { schema });
  cached = { client, db };
  return db;
}

export function makeDb(url: string, authToken?: string): { client: Client; db: Db } {
  const client = createClient({ url, authToken });
  const db = drizzle(client, { schema });
  return { client, db };
}
