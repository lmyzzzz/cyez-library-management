import { mkdir, writeFile, access, chmod } from "node:fs/promises";
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
// Compose file-based secrets keep the host owner and mode. 0700 on the
// directory keeps them private on the host, while 0444 lets the non-root
// container UIDs (postgres 999, nginx 101, node 1000) read the bind-mounted
// file. The explicit chmod also covers restrictive host umasks.
await mkdir("secrets", { recursive: true, mode: 0o700 });
await chmod("secrets", 0o700);
await mkdir("runtime/adapters", { recursive: true });
const writeSecret = async (name: string, contents: string) => {
  const file = `secrets/${name}`;
  await writeFile(file, contents, { mode: 0o444 });
  await chmod(file, 0o444);
};
await Promise.all([
  writeSecret("server.crt", cert.cert),
  writeSecret("server.key", cert.key),
  writeSecret("db-password", dbPassword),
  writeSecret(
    "migration-database-url",
    `postgres://cyez_migrate:${dbPassword}@db:5432/cyez`,
  ),
  writeSecret(
    "runtime-database-url",
    `postgres://cyez_runtime:${runtimePassword}@db:5432/cyez`,
  ),
  writeSecret("provider-config-key", randomBytes(32).toString("hex")),
  writeFile(
    ".env.integration",
    `APP_ENV=integration\nRELEASE_TAG=local\nDATA_PREFIX=cyez-record-integration\nBIND_IP=127.0.0.1\nHTTPS_PORT=8443\nTEACHER_USERNAME=teacher-integration\nTEACHER_PASSWORD=${teacherPassword}\nHASH_VERSION=${identity.hashVersion}\nFIXED_SALT_HEX=${identity.fixedSaltHex}\nCARD_ISSUER=${identity.issuer}\nUID_BYTE_LENGTHS=4\nPROVIDER_MODE=fake\nPROVIDER_CONFIG_KEY_HOST_PATH=./secrets/provider-config-key\nPROFILE_CONTRACT_CONFIRMED=false\n`,
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
