import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { MigrationBuilder, runner } from "node-pg-migrate";
import { Database } from "../../apps/server/src/database.js";
import { identity } from "./config.js";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

// Isolated test database, provisioned by the same schema and role migrations as deployment.
export async function runtimeDatabase() {
  const adminUrl =
    process.env.TEST_RUNTIME_ADMIN_URL ??
    process.env.TEST_DATABASE_URL ??
    "postgres://cyez_test:integration-only@127.0.0.1:55432/cyez_test";
  const admin = new Database(adminUrl);
  const suffix = randomUUID().replaceAll("-", "");
  const name = "cyez_runtime_" + suffix;
  const role = "runtime_" + suffix;
  const directory = await mkdtemp(join(tmpdir(), "cyez-runtime-test-"));
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = "/" + name;
  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = role;
  runtimeUrl.password = randomBytes(24).toString("hex");
  const owner = new Database(ownerUrl.toString());
  const db = new Database(runtimeUrl.toString());
  let created = false;
  const privileges = async (
    change: (pgm: MigrationBuilder) => void,
    connectionString = ownerUrl.toString(),
  ) => {
    const pg = new Client({ connectionString });
    await pg.connect();
    try {
      const pgm = new MigrationBuilder(
        {
          query: pg.query.bind(pg),
          select: async (query, values?: unknown[]) =>
            (await pg.query(query as string, values)).rows,
        },
        undefined,
        false,
        quiet,
      );
      change(pgm);
      for (const sql of pgm.getSqlSteps()) await pg.query(sql);
    } finally {
      await pg.end();
    }
  };
  const close = async () => {
    await db.close();
    await owner.close();
    if (created) {
      await admin.sequelize.getQueryInterface().dropDatabase(name);
      await privileges(
        (pgm) => pgm.dropRole(role, { ifExists: true }),
        adminUrl,
      );
    }
    await admin.close();
  };
  try {
    await admin.sequelize.getQueryInterface().createDatabase(name);
    created = true;
    await owner.migrator.up();
    await owner.initializeIdentity(identity);
    const ownerFile = join(directory, "owner-url");
    const runtimeFile = join(directory, "runtime-url");
    await writeFile(ownerFile, ownerUrl.toString());
    await writeFile(runtimeFile, runtimeUrl.toString());
    const old = {
      DATABASE_URL_FILE: process.env.DATABASE_URL_FILE,
      RUNTIME_DATABASE_URL_FILE: process.env.RUNTIME_DATABASE_URL_FILE,
    };
    try {
      process.env.DATABASE_URL_FILE = ownerFile;
      process.env.RUNTIME_DATABASE_URL_FILE = runtimeFile;
      await runner({
        databaseUrl: ownerUrl.toString(),
        dir: fileURLToPath(
          new URL("../../apps/server/src/roles", import.meta.url),
        ),
        migrationsTable: "role_migrations",
        ignorePattern: ".*\\.d\\.ts",
        direction: "up",
        logger: quiet,
      });
    } finally {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    await db.ready();
    return {
      db,
      owner,
      role,
      directory,
      url: runtimeUrl.toString(),
      privileges,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
