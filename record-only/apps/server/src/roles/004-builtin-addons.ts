import type { MigrationBuilder } from "node-pg-migrate";
import { readFile } from "node:fs/promises";
export async function up(pgm: MigrationBuilder) {
  const file = process.env.RUNTIME_DATABASE_URL_FILE;
  if (!file) throw new Error("RUNTIME_DATABASE_URL_FILE_REQUIRED");
  const role = decodeURIComponent(
    new URL((await readFile(file, "utf8")).trim()).username,
  );
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(role))
    throw new Error("RUNTIME_ROLE_INVALID");
  pgm.grantOnTables({
    tables: ["builtin_addons"],
    roles: role,
    privileges: ["SELECT", "UPDATE"],
  });
}
