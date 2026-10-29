import type { MigrationBuilder } from "node-pg-migrate";
import { readFile } from "node:fs/promises";
import { Sequelize, DataTypes } from "sequelize";
/** Operational role provisioning only. Business schema migrations remain QueryInterface/Umzug.
 * All SQL is generated and executed by the library's structured role/grant APIs. */
export async function up(pgm: MigrationBuilder) {
  const file = process.env.RUNTIME_DATABASE_URL_FILE;
  if (!file) throw new Error("RUNTIME_DATABASE_URL_FILE_REQUIRED");
  const runtime = new URL((await readFile(file, "utf8")).trim());
  const role = decodeURIComponent(runtime.username),
    password = decodeURIComponent(runtime.password);
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(role) || password.length < 16)
    throw new Error("RUNTIME_ROLE_INVALID");
  const adminFile = process.env.DATABASE_URL_FILE;
  const adminUrl = adminFile
    ? (await readFile(adminFile, "utf8")).trim()
    : process.env.DATABASE_URL!;
  const db = new Sequelize(adminUrl, { logging: false });
  const roles = db.define(
    "ExistingRole",
    { rolname: { type: DataTypes.STRING, primaryKey: true } },
    { tableName: "pg_roles", schema: "pg_catalog", timestamps: false },
  );
  try {
    if (!(await roles.findByPk(role)))
      pgm.createRole(role, {
        login: true,
        password,
        superuser: false,
        createdb: false,
        createrole: false,
        replication: false,
        bypassrls: false,
      });
    else
      pgm.alterRole(role, {
        login: true,
        password,
        superuser: false,
        createdb: false,
        createrole: false,
        replication: false,
        bypassrls: false,
      });
  } finally {
    await db.close();
  }
  pgm.revokeOnSchemas({
    schemas: "public",
    roles: "PUBLIC",
    privileges: "CREATE",
  });
  pgm.grantOnSchemas({ schemas: "public", roles: role, privileges: "USAGE" });
  pgm.grantOnTables({
    tables: ["SequelizeMeta", "settings"],
    roles: role,
    privileges: "SELECT",
  });
  pgm.grantOnTables({
    tables: ["students"],
    roles: role,
    privileges: ["SELECT", "UPDATE"],
  });
  pgm.grantOnTables({
    tables: ["devices", "tags", "device_tags"],
    roles: role,
    privileges: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  });
  pgm.grantOnTables({
    tables: ["usage_records"],
    roles: role,
    privileges: ["SELECT", "INSERT", "UPDATE"],
  });
  pgm.grantOnTables({
    tables: ["operations", "app_logs"],
    roles: role,
    privileges: ["SELECT", "INSERT"],
  });
  pgm.grantOnTables({
    tables: ["audit_events"],
    roles: role,
    privileges: "INSERT",
  });
}
