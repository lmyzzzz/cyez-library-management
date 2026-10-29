import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { Database } from "./database.js";
import { seedStudents, integrationSeed } from "./seed.js";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
let db: Database | undefined;
try {
  const config = loadConfig();
  db = new Database(config.databaseUrl);
  const command = process.argv[2];
  if (command === "migrate") {
    await db.migrator.up();
    if (process.env.RUNTIME_DATABASE_URL_FILE)
      await runner({
        databaseUrl: config.databaseUrl,
        dir: fileURLToPath(new URL("./roles", import.meta.url)),
        migrationsTable: "role_migrations",
        ignorePattern: ".*\\.d\\.ts",
        direction: "up",
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      });
    console.log("MIGRATIONS_COMPLETE");
  } else if (command === "seed") {
    await db.ready();
    const file = process.argv[3];
    let input: unknown;
    if (file === "--integration") {
      if (config.environment === "production")
        throw new Error("INTEGRATION_SEED_FORBIDDEN");
      input = integrationSeed(config.identity);
    } else {
      if (!file) throw new Error("SEED_FILE_REQUIRED");
      input = JSON.parse(await readFile(file, "utf8"));
    }
    console.log(JSON.stringify(await seedStudents(db, input, config.identity)));
  } else throw new Error("COMMAND_INVALID");
} catch {
  console.error("CONTROLLED_OPERATION_FAILED: no input contents were logged.");
  process.exitCode = 1;
} finally {
  await db?.close();
}
