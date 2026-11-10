import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, request as httpsRequest, type Server } from "node:https";
import { request as httpRequest } from "node:http";
import { createApp } from "../../../apps/server/src/app.js";
import { SqlServerCampusProvider } from "../../../apps/server/src/provider-sqlserver.js";
import {
  sqlServerProviderSchema,
  type SqlServerProviderConfig,
} from "@record/protocol";
import { studentId } from "@record/protocol/identity";
import { runtimeDatabase } from "../../helpers/runtime-database.js";
import { certificate } from "../../helpers/certificates.js";
import { identity, testConfig } from "../../helpers/config.js";

describe.skipIf(!process.env.TEST_SQLSERVER_CONFIG)(
  "生产配置：HTTPS / 真实 SQL Server / 受限 PostgreSQL runtime",
  () => {
    let fixture: Awaited<ReturnType<typeof runtimeDatabase>>;
    let api: Awaited<ReturnType<typeof createApp>>;
    let tls: Server;
    let port: number;
    let token: string;
    let input: SqlServerProviderConfig;
    const cert = certificate();
    const clientId = randomUUID();
    let config: Parameters<typeof createApp>[0];
    async function post(path: string, body: unknown) {
      return new Promise<{ status: number; body: Record<string, any> }>(
        (resolve, reject) => {
          const req = httpsRequest(
            {
              hostname: "127.0.0.1",
              port,
              path,
              method: "POST",
              ca: cert.cert,
              headers: {
                "content-type": "application/json",
                authorization: "Bearer " + token,
              },
            },
            (res) => {
              let text = "";
              res.on("data", (chunk) => {
                text += chunk;
              });
              res.on("error", reject);
              res.on("end", () =>
                resolve({ status: res.statusCode!, body: JSON.parse(text) }),
              );
            },
          );
          req.on("error", reject);
          req.end(JSON.stringify(body));
        },
      );
    }
    async function start() {
      api = await createApp(config);
      await api.app.listen({ host: "127.0.0.1", port: 0 });
      const backendPort = (api.app.server.address() as { port: number }).port;
      tls = createServer(cert, (incoming, response) => {
        const proxy = httpRequest(
          {
            hostname: "127.0.0.1",
            port: backendPort,
            path: incoming.url,
            method: incoming.method,
            headers: incoming.headers,
          },
          (upstream) => {
            response.writeHead(upstream.statusCode!, upstream.headers);
            upstream.pipe(response);
          },
        );
        proxy.on("error", () => {
          response.writeHead(503);
          response.end("{}");
        });
        incoming.pipe(proxy);
      });
      await new Promise<void>((r) => tls.listen(0, "127.0.0.1", r));
      port = (tls.address() as { port: number }).port;
      const login = await post("/api/v1/auth/login", {
        username: config.username,
        password: config.password,
        clientId,
      });
      expect(login.status).toBe(200);
      token = login.body.token;
    }
    async function stop() {
      if (tls?.listening) await new Promise<void>((r) => tls.close(() => r()));
      await api?.app.close();
    }
    beforeAll(async () => {
      fixture = await runtimeDatabase();
      input = {
        ...sqlServerProviderSchema.parse(
          JSON.parse(
            await readFile(process.env.TEST_SQLSERVER_CONFIG!, "utf8"),
          ),
        ),
        caPem: "",
        tlsValidation: "trustServerCertificate",
      };
      const keyFile = join(fixture.directory, "provider-key");
      await writeFile(keyFile, randomBytes(32).toString("hex"));
      config = {
        ...testConfig(fixture.url, join(fixture.directory, "spool")),
        environment: "production",
        providerMode: "sqlserver",
        providerConfigKeyFile: keyFile,
        providerTimeoutMs: 3000,
      };
      await start();
    });
    afterAll(async () => {
      await stop();
      await fixture?.close();
    });

    const scan = () =>
      post("/api/v1/scan-previews", {
        scanId: randomUUID(),
        studentId: studentId(
          { issuer: identity.issuer, uidHex: "00000001" },
          identity,
        ),
        hashVersion: identity.hashVersion,
        card: { issuer: identity.issuer, uidHex: "00000001" },
        source: "reader",
      });

    it("审计只写权限确实拒绝 RETURNING，但允许不回读的 INSERT", async () => {
      await expect(fixture.db.audits.findAll()).rejects.toMatchObject({
        original: { code: "42501" },
      });
      const audit = {
        id: randomUUID(),
        actor: config.username,
        clientId,
        requestId: null,
        scanId: null,
        studentId: null,
        recordId: null,
        deviceId: null,
        action: "permission_probe",
        fields: [],
        at: new Date(),
      };
      await expect(fixture.db.audits.create(audit)).rejects.toMatchObject({
        original: { code: "42501" },
      });
      await fixture.db.audits.create(audit, { returning: false });
      expect(await fixture.owner.audits.count()).toBe(1);
      await fixture.owner.audits.destroy({ where: { id: audit.id } });
    });
    it("TOP(0) 成功后以 runtime 保存配置和审计，首次及重复覆盖、刷卡和重启均成功", async () => {
      await new SqlServerCampusProvider(input, 3000).probe();
      expect(await post("/api/v1/provider-config", input)).toEqual({
        status: 200,
        body: { ok: true },
      });
      const first = (await fixture.owner.providerConfigs.findByPk(
        "campus",
      ))!.get().sealed;
      expect(first).not.toContain(input.password);
      expect(await post("/api/v1/provider-config", input)).toEqual({
        status: 200,
        body: { ok: true },
      });
      expect(
        (await fixture.owner.providerConfigs.findByPk("campus"))!.get().sealed,
      ).not.toBe(first);
      expect(
        await fixture.owner.audits.count({
          where: { action: "provider_config_replaced" },
        }),
      ).toBe(2);
      expect(await scan()).toMatchObject({
        status: 200,
        body: { student: { name: "测试学生" } },
      });
      await stop();
      await start();
      expect(await scan()).toMatchObject({
        status: 200,
        body: { student: { name: "测试学生" } },
      });
    });
    it("探测失败与保存/审计权限失败可区分；事务回滚保留原配置且日志无配置值", async () => {
      const sealed = (await fixture.owner.providerConfigs.findByPk(
        "campus",
      ))!.get().sealed;
      const count = await fixture.owner.audits.count({
        where: { action: "provider_config_replaced" },
      });
      expect(
        await post("/api/v1/provider-config", {
          ...input,
          tlsValidation: "verify",
        }),
      ).toEqual({
        status: 422,
        body: { code: "PROVIDER_CONFIGURATION_INVALID" },
      });
      for (const [table, privilege] of [
        ["provider_configs", "UPDATE"],
        ["audit_events", "INSERT"],
      ] as const) {
        await fixture.privileges((pgm) =>
          pgm.revokeOnTables({
            tables: table,
            roles: fixture.role,
            privileges: privilege,
          }),
        );
        try {
          expect(
            await post("/api/v1/provider-config", {
              ...input,
              uidEncoding: "hex8",
            }),
          ).toEqual({
            status: 503,
            body: { code: "PROVIDER_CONFIGURATION_SAVE_FAILED" },
          });
        } finally {
          await fixture.privileges((pgm) =>
            pgm.grantOnTables({
              tables: table,
              roles: fixture.role,
              privileges: privilege,
            }),
          );
        }
        expect(
          (await fixture.owner.providerConfigs.findByPk("campus"))!.get()
            .sealed,
        ).toBe(sealed);
        expect(
          await fixture.owner.audits.count({
            where: { action: "provider_config_replaced" },
          }),
        ).toBe(count);
        // Decimal lookup still succeeds: rejected hex8 configuration never becomes live.
        expect(await scan()).toMatchObject({
          status: 200,
          body: { student: { name: "测试学生" } },
        });
      }
      const logs = await Promise.all(
        (await readdir(config.spoolDir))
          .filter((f) => f.endsWith(".json"))
          .map(async (f) =>
            JSON.parse(await readFile(join(config.spoolDir, f), "utf8")),
          ),
      );
      expect(logs.map((l) => l.code).sort()).toEqual([
        "PROVIDER_CONFIGURATION_INVALID",
        "PROVIDER_CONFIGURATION_SAVE_FAILED",
        "PROVIDER_CONFIGURATION_SAVE_FAILED",
      ]);
      const text = JSON.stringify(logs);
      for (const value of [
        input.password,
        input.username,
        input.host,
        "00000001",
        sealed,
      ])
        expect(text).not.toContain(value);
      await expect(fixture.db.audits.findAll()).rejects.toMatchObject({
        original: { code: "42501" },
      });
    });
  },
);
