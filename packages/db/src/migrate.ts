import { migrate } from "drizzle-orm/libsql/migrator";
import { createLogger } from "@trihards/core";
import { makeDb } from "./client";

const log = createLogger("db:migrate");

async function run() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL is not set");
  log.info("running migrations", { url });
  const { db, client } = makeDb(url, process.env.TURSO_AUTH_TOKEN);
  await migrate(db, { migrationsFolder: "./migrations" });
  client.close();
  log.info("migrations applied");
}

run().catch((err) => {
  log.error("migration failed", err);
  process.exit(1);
});
