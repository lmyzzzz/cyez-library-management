// Isolated integration fixture, never a production deployment or a campus seed.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import sql from "mssql";
import { certificate } from "../tests/helpers/certificates.js";

const directory = resolve("runtime/sqlserver-test");
const wsl = process.env.CYEZ_DOCKER_WSL === "1";
const docker = (...args: string[]) =>
  execFileSync(
    wsl ? "wsl.exe" : "docker",
    wsl ? ["-u", "root", "--exec", "docker", ...args] : args,
    { encoding: "utf8" },
  );
if (
  docker(
    "ps",
    "--all",
    "--filter",
    "name=^/cyez-sqlserver-test$",
    "--format",
    "{{.Names}}",
  ).trim()
)
  throw new Error("SQLSERVER_FIXTURE_ALREADY_EXISTS");
await mkdir(directory, { recursive: true });
const cert = certificate();
const password = "Integration!" + randomBytes(24).toString("hex");
await writeFile(join(directory, "server.crt"), cert.cert);
await writeFile(join(directory, "server.key"), cert.key, { mode: 0o600 });
await writeFile(
  join(directory, "container.env"),
  `ACCEPT_EULA=Y\nMSSQL_PID=Developer\nMSSQL_SA_PASSWORD=${password}\n`,
  { mode: 0o600 },
);
await writeFile(
  join(directory, "mssql.conf"),
  "[network]\ntlscert = /var/opt/mssql/server.crt\ntlskey = /var/opt/mssql/server.key\ntlsprotocols = 1.2\nforceencryption = 1\n",
);
const mount = wsl
  ? execFileSync(
      "wsl.exe",
      [
        "-u",
        "root",
        "--exec",
        "wslpath",
        "-a",
        directory.replaceAll("\\", "/"),
      ],
      { encoding: "utf8" },
    ).trim()
  : directory;
// Refuse to replace any existing container; the operator owns its lifecycle.
docker(
  "run",
  "--detach",
  "--name",
  "cyez-sqlserver-test",
  "--user",
  "root",
  "--publish",
  "127.0.0.1:51433:1433",
  "--env-file",
  `${mount}/container.env`,
  "--mount",
  `type=bind,src=${mount},dst=/fixture,readonly`,
  "--entrypoint",
  "/bin/bash",
  "mcr.microsoft.com/mssql/server:2022-latest@sha256:cf8f0ab2ebe61feec2eed2629061a07d247f791c2a8ddda74a4ac9f06a291718",
  "-c",
  "cp /fixture/server.crt /fixture/server.key /fixture/mssql.conf /var/opt/mssql/ && chmod 600 /var/opt/mssql/server.key && exec /opt/mssql/bin/sqlservr",
);
const options: sql.config = {
  server: "127.0.0.1",
  port: 51433,
  user: "sa",
  password,
  connectionTimeout: 2000,
  options: {
    encrypt: true,
    trustServerCertificate: false,
    cryptoCredentialsDetails: { ca: cert.cert },
  },
};
let pool: sql.ConnectionPool | undefined;
for (let attempt = 0; attempt < 60; attempt++) {
  const candidate = new sql.ConnectionPool(options);
  try {
    pool = await candidate.connect();
    break;
  } catch {
    await candidate.close();
    await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!pool) throw new Error("SQLSERVER_FIXTURE_NOT_READY");
try {
  await pool
    .request()
    .query("CREATE DATABASE [Concard] COLLATE Chinese_PRC_CI_AS");
  await pool.request().query(`USE [Concard]; CREATE TABLE dbo.fixture (
    [账号] int NOT NULL, [卡号] varchar(20) NULL, [姓名] varchar(16) NULL,
    [证件号] varchar(18) NULL, [卡状态] int NULL, [身份] varchar(64) NOT NULL,
    [班级] varchar(64) NOT NULL, [身份证号] varchar(18) NULL);
    INSERT INTO dbo.fixture VALUES
    (1, '1', N'测试学生', NULL, 0, N'学生', N'Ⅰ（1班）', NULL),
    (2, '2', NULL, NULL, 0, N'学生', N'Ⅰ（1班）', NULL),
    (3, '3', N'重复一', NULL, 0, N'学生', N'Ⅰ（1班）', NULL),
    (4, '3', N'重复二', NULL, 0, N'学生', N'Ⅰ（1班）', NULL),
    (5, '00000004', N'十六进制', NULL, 0, N'学生', N'Ⅰ（1班）', NULL);`);
  await pool
    .request()
    .query(
      "USE [Concard]; EXEC(N'CREATE VIEW dbo.v_ViewCardInfo AS SELECT [账号], [卡号], [姓名], [证件号], [卡状态], [身份], [班级], [身份证号] FROM dbo.fixture')",
    );
  // Generated test password is hex after a fixed safe prefix; no real credentials or rows.
  await pool.request()
    .query(`CREATE LOGIN [cyez_card_test] WITH PASSWORD = '${password}';
    USE [Concard]; CREATE USER [cyez_card_test] FOR LOGIN [cyez_card_test];
    GRANT SELECT ON OBJECT::dbo.v_ViewCardInfo ([卡号], [姓名], [班级]) TO [cyez_card_test];`);
  await writeFile(
    join(directory, "connection.json"),
    JSON.stringify({
      host: "127.0.0.1",
      port: 51433,
      username: "cyez_card_test",
      password,
      caPem: cert.cert,
      uidEncoding: "decimal",
    }),
    { mode: 0o600 },
  );
  console.log(
    "SQLSERVER_FIXTURE_READY: runtime/sqlserver-test/connection.json",
  );
} finally {
  await pool.close();
}
