import { mkdir, writeFile, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { certificate } from "../tests/helpers/certificates.js";
import { identity } from "../tests/helpers/config.js";
try {
  await access(".env.integration");
  throw new Error(
    "Integration configuration already exists; reuse it. Do not overwrite credentials of an existing database.",
  );
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
const cert = certificate();
const dbPassword = randomBytes(24).toString("hex"),
  runtimePassword = randomBytes(24).toString("hex"),
  teacherPassword = randomBytes(24).toString("hex");
await mkdir("secrets", { recursive: true });
await mkdir("runtime/adapters", { recursive: true });
await Promise.all([
  writeFile("secrets/server.crt", cert.cert),
  writeFile("secrets/server.key", cert.key, { mode: 0o600 }),
  writeFile("secrets/db-password", dbPassword, { mode: 0o600 }),
  writeFile(
    "secrets/migration-database-url",
    `postgres://cyez_migrate:${dbPassword}@db:5432/cyez`,
    { mode: 0o600 },
  ),
  writeFile(
    "secrets/runtime-database-url",
    `postgres://cyez_runtime:${runtimePassword}@db:5432/cyez`,
    { mode: 0o600 },
  ),
  writeFile("secrets/provider-credential", "integration-unused", {
    mode: 0o600,
  }),
  writeFile(
    ".env.integration",
    `APP_ENV=integration\nRELEASE_TAG=local\nDATA_PREFIX=cyez-record-integration\nBIND_IP=127.0.0.1\nHTTPS_PORT=8443\nTEACHER_USERNAME=teacher-integration\nTEACHER_PASSWORD=${teacherPassword}\nHASH_VERSION=${identity.hashVersion}\nFIXED_SALT_HEX=${identity.fixedSaltHex}\nCARD_ISSUER=${identity.issuer}\nUID_BYTE_LENGTHS=4\nPROVIDER_MODE=fake\nPROFILE_CONTRACT_CONFIRMED=false\n`,
    { mode: 0o600 },
  ),
  writeFile(
    "runtime/integration-connection.json",
    JSON.stringify({
      ip: "127.0.0.1",
      port: 8443,
      pin: cert.pin,
      username: "teacher-integration",
      password: teacherPassword,
    }),
    { mode: 0o600 },
  ),
]);
console.log(
  "Integration-only configuration written to ignored secrets/, .env.integration and runtime/. No credentials printed.",
);
