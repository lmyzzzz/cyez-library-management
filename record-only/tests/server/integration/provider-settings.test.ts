import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../../apps/server/src/database.js";
import { createApp } from "../../../apps/server/src/app.js";
import { testConfig, identity } from "../../helpers/config.js";
import { studentId } from "@record/protocol/identity";
import { ApiError, type SqlServerProviderConfig } from "@record/protocol";
import type { Config } from "../../../apps/server/src/config.js";
import { ProviderSettings } from "../../../apps/server/src/provider-settings.js";
import { runtimeDatabase } from "../../helpers/runtime-database.js";

describe("真实 PostgreSQL：校园数据源仅覆盖配置", () => {
  const clientId = randomUUID();
  const input = (host: string): SqlServerProviderConfig => ({
    host,
    port: 1433,
    username: "readonly",
    password: "transient-password-value",
    caPem: "",
    uidEncoding: "hex8",
  });
  let fixture: Awaited<ReturnType<typeof runtimeDatabase>>,
    db: Database,
    server: Awaited<ReturnType<typeof createApp>>,
    config: Config,
    token: string,
    calls: string[] = [];
  const factory = (value: SqlServerProviderConfig) => ({
    async probe() {
      if (value.host === "bad.example")
        throw new ApiError("PROVIDER_CONFIGURATION_INVALID", 422);
    },
    async lookup() {
      calls.push(value.host);
      return { name: value.host, className: "一班", schoolNumber: "S1" };
    },
  });
  beforeAll(async () => {
    fixture = await runtimeDatabase();
    const dir = fixture.directory;
    const keyFile = join(dir, "key");
    await writeFile(keyFile, randomBytes(32).toString("hex"));
    config = {
      ...testConfig(fixture.url, dir),
      environment: "production",
      providerMode: "sqlserver",
      providerConfigKeyFile: keyFile,
    };
    db = fixture.db;
    server = await createApp(config, {
      database: db,
      providerFactory: factory,
      probe: async () => ({
        freeBytes: 100000,
        writable: true,
        oldestAgeMs: 0,
      }),
    });
    token = (
      await server.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          username: config.username,
          password: config.password,
          clientId,
        },
      })
    ).json().token;
  });
  afterAll(async () => {
    await server?.app.close();
    await fixture?.close();
  });
  const post = async (payload: unknown, authorization = token) =>
    server.app.inject({
      method: "POST",
      url: "/api/v1/provider-config",
      headers: { authorization: "Bearer " + authorization },
      payload: payload as never,
    });
  const scan = async () =>
    server.app.inject({
      method: "POST",
      url: "/api/v1/scan-previews",
      headers: { authorization: "Bearer " + token },
      payload: {
        scanId: randomUUID(),
        studentId: studentId(
          { issuer: identity.issuer, uidHex: "00000001" },
          identity,
        ),
        hashVersion: identity.hashVersion,
        card: { issuer: identity.issuer, uidHex: "00000001" },
        source: "reader",
      },
    });
  it("未配置时刷卡拒绝、未认证不能覆盖、没有读取接口", async () => {
    expect((await scan()).json()).toEqual({ code: "PROVIDER_UNAVAILABLE" });
    expect((await post(input("first.example"), "invalid")).statusCode).toBe(
      401,
    );
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: "/api/v1/provider-config",
          headers: { authorization: "Bearer " + token },
        })
      ).statusCode,
    ).toBe(404);
    expect(await fixture.owner.providerConfigs.findByPk("campus")).toBeNull();
  });
  it("校验失败不覆盖，成功时密文落库且原文不回传", async () => {
    expect(
      (await post({ ...input("first.example"), extra: true })).statusCode,
    ).toBe(422);
    expect((await post(input("bad.example"))).json()).toEqual({
      code: "PROVIDER_CONFIGURATION_INVALID",
    });
    expect(await fixture.owner.providerConfigs.findByPk("campus")).toBeNull();
    const success = await post(input("first.example"));
    expect(success.statusCode).toBe(200);
    expect(success.json()).toEqual({ ok: true });
    const sealed = (await fixture.owner.providerConfigs.findByPk(
      "campus",
    ))!.get().sealed;
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("transient-password-value");
    expect(sealed).not.toContain("first.example");
    expect((await scan()).json().student.name).toBe("first.example");
    expect(calls).toEqual(["first.example"]);
    const failed = await post(input("bad.example"));
    expect(failed.statusCode).toBe(422);
    expect(
      (await fixture.owner.providerConfigs.findByPk("campus"))!.get().sealed,
    ).toBe(sealed);
    expect((await scan()).json().student.name).toBe("first.example");
  });
  it("重启后仅服务端恢复配置，完整覆盖使新配置生效", async () => {
    await server.app.close();
    db = new Database(config.databaseUrl);
    server = await createApp(config, {
      database: db,
      providerFactory: factory,
      probe: async () => ({
        freeBytes: 100000,
        writable: true,
        oldestAgeMs: 0,
      }),
    });
    token = (
      await server.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          username: config.username,
          password: config.password,
          clientId,
        },
      })
    ).json().token;
    expect((await scan()).json().student.name).toBe("first.example");
    expect((await post(input("second.example"))).statusCode).toBe(200);
    expect((await scan()).json().student.name).toBe("second.example");
    expect(calls.at(-1)).toBe("second.example");
    expect(
      (
        await fixture.owner.audits.findAll({
          where: { action: "provider_config_replaced" },
        })
      ).length,
    ).toBe(2);
  });
  it("局部修改拒绝，审计写入失败回滚配置，错误密钥/密文不静默重置", async () => {
    for (const method of ["PATCH", "PUT", "DELETE"] as const) {
      expect(
        (
          await server.app.inject({
            method,
            url: "/api/v1/provider-config",
            headers: { authorization: "Bearer " + token },
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
    }
    const before = (await fixture.owner.providerConfigs.findByPk(
      "campus",
    ))!.get().sealed;
    const failure = vi
      .spyOn(db.audits, "create")
      .mockRejectedValueOnce(new Error("simulated storage failure"));
    try {
      const failed = await post(input("rollback.example"));
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toEqual({
        code: "PROVIDER_CONFIGURATION_SAVE_FAILED",
      });
    } finally {
      failure.mockRestore();
    }
    expect(
      (await fixture.owner.providerConfigs.findByPk("campus"))!.get().sealed,
    ).toBe(before);
    expect((await scan()).json().student.name).toBe("second.example");
    const badKey = join(await mkdtemp(join(tmpdir(), "cyez-bad-key-")), "key");
    await writeFile(badKey, "invalid");
    await expect(
      ProviderSettings.create(db, badKey, 200, factory),
    ).rejects.toThrow("PROVIDER_CONFIG_KEY_INVALID");
    await writeFile(badKey, randomBytes(32).toString("hex"));
    await expect(
      ProviderSettings.create(db, badKey, 200, factory),
    ).rejects.toThrow("PROVIDER_CONFIG_DECRYPT_FAILED");
    expect(
      (await fixture.owner.providerConfigs.findByPk("campus"))!.get().sealed,
    ).toBe(before);
  });
});
