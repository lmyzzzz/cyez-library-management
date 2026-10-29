import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, configSchema } from "../../../apps/server/src/config.js";
import {
  loadProvider,
  providerHttpsJson,
  refreshProfile,
} from "../../../apps/server/src/provider.js";
import { Capacity, Spool } from "../../../apps/server/src/storage.js";
import { testConfig, identity } from "../../helpers/config.js";
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("配置与适配器的失败边界", () => {
  it("配置从显式环境和秘密文件读取，默认值与非法生产配置", async () => {
    const folder = await mkdtemp(join(tmpdir(), "cyez-config-")),
      file = join(folder, "db");
    await writeFile(file, "postgres://test:example@localhost/db\n");
    const env = {
      APP_ENV: "integration",
      DATABASE_URL_FILE: file,
      TEACHER_USERNAME: "teacher",
      TEACHER_PASSWORD: "only-a-test-password",
      HASH_VERSION: identity.hashVersion,
      FIXED_SALT_HEX: identity.fixedSaltHex,
      CARD_ISSUER: identity.issuer,
      UID_BYTE_LENGTHS: "4",
      PROVIDER_MODE: "fake",
    };
    const c = loadConfig(env);
    expect(c.port).toBe(3000);
    expect(c.databaseUrl).toBe("postgres://test:example@localhost/db");
    expect(c.identity.uidByteLengths).toEqual([4]);
    expect(
      loadConfig({
        ...env,
        DATABASE_URL_FILE: undefined,
        DATABASE_URL: "postgres://a:b@localhost/d",
        HOST: "127.0.0.1",
        PORT: "4000",
        PROVIDER_TIMEOUT_MS: "1000",
        PROFILE_CONTRACT_CONFIRMED: "true",
      }).port,
    ).toBe(4000);
    expect(() => loadConfig({ ...env, TEACHER_PASSWORD: "" })).toThrow();
    expect(() => loadConfig({ ...env, APP_ENV: "production" })).toThrow();
    expect(
      configSchema.safeParse({
        ...c,
        providerMode: "module",
        providerModule: "/adapter.mjs",
        profileContractConfirmed: true,
        environment: "production",
      }).success,
    ).toBe(true);
  });
  it("替换模块必须显式配置，生产永不加载 fake", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyez-provider-")),
      config = testConfig("postgres://a:b@localhost/d", dir);
    expect(await loadProvider(config)).toBeDefined();
    await expect(
      loadProvider({ ...config, environment: "production" }),
    ).rejects.toThrow("FAKE_PROVIDER_FORBIDDEN");
    const valid = join(dir, "valid.mjs"),
      invalid = join(dir, "invalid.mjs");
    await writeFile(
      valid,
      'export function createProvider(){return {lookup: async()=>({name:"测试",className:"班",schoolNumber:"N"})}}',
    );
    await writeFile(invalid, "export function createProvider(){return {}}");
    const p = await loadProvider({
      ...config,
      providerMode: "module",
      providerModule: valid,
    });
    expect(
      await p.lookup(
        { issuer: "i", uidHex: "00" },
        new AbortController().signal,
      ),
    ).toMatchObject({ name: "测试" });
    await expect(
      loadProvider({
        ...config,
        providerMode: "module",
        providerModule: invalid,
      }),
    ).rejects.toThrow("PROVIDER_ADAPTER_INVALID");
  });
  it("HTTP helper 严格 HTTPS、拒绝降级/重定向、响应限长与错误脱敏", async () => {
    const signal = new AbortController().signal;
    const body = { card: "TEST-ONLY" };
    let options: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        options = init;
        return new Response('{"name":"测试"}');
      }),
    );
    expect(
      await providerHttpsJson(
        "https://provider.invalid/lookup",
        body,
        {},
        signal,
      ),
    ).toEqual({ name: "测试" });
    expect(options?.redirect).toBe("error");
    expect(options?.signal).toBe(signal);
    await expect(
      providerHttpsJson("http://provider.invalid", body, {}, signal),
    ).rejects.toMatchObject({ code: "PROVIDER_CONFIGURATION_INVALID" });
    await expect(
      providerHttpsJson(
        "https://user:password@provider.invalid",
        body,
        {},
        signal,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_CONFIGURATION_INVALID" });
    for (const response of [
      new Response("failure", { status: 503 }),
      new Response(null),
      new Response("invalid json"),
      new Response("x".repeat(70000)),
    ]) {
      vi.stubGlobal("fetch", async () => response);
      await expect(
        providerHttpsJson("https://provider.invalid", body, {}, signal),
      ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    }
    vi.stubGlobal("fetch", async () => {
      throw Error("secret card in upstream error");
    });
    await expect(
      providerHttpsJson("https://provider.invalid", body, {}, signal),
    ).rejects.toThrow("PROVIDER_UNAVAILABLE");
  });
  it("运行中取消和 provider 原始错误不会外泄，输入按生命周期释放", async () => {
    const card = { issuer: "integration", uidHex: "00000001" },
      controller = new AbortController();
    const result = refreshProfile(
      { lookup: async () => new Promise(() => {}) },
      card,
      1000,
      controller.signal,
    );
    controller.abort();
    await expect(result).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(card.uidHex).toBe("");
    await expect(
      refreshProfile(
        {
          lookup: async () => {
            throw Error("sensitive response");
          },
        },
        { issuer: "integration", uidHex: "00000001" },
        10,
      ),
    ).rejects.toThrow("PROVIDER_UNAVAILABLE");
  });
});
describe("真实文件系统 spool 与容量规则", () => {
  it("fsync 写入及真实空间探测，预警/限写/失败和恢复滞后量", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyez-storage-")),
      spool = new Spool(dir),
      config = testConfig("postgres://a:b@localhost/d", dir);
    const actual = new Capacity(config, spool);
    expect((await actual.status()).mode).toBe("normal");
    expect(
      (await readdir(dir)).filter((f) => f.startsWith(".probe")),
    ).toHaveLength(0);
    let p = { freeBytes: 800, writable: true, oldestAgeMs: 0 };
    const capacity = new Capacity(config, spool, async () => p);
    expect((await capacity.status()).mode).toBe("warning");
    p.freeBytes = 400;
    expect((await capacity.status()).mode).toBe("restricted");
    await expect(capacity.require("start")).rejects.toThrow();
    await capacity.require("end");
    p.freeBytes = 1500;
    expect((await capacity.status()).mode).toBe("restricted");
    p.freeBytes = 3000;
    expect((await capacity.status()).mode).toBe("normal");
    p.writable = false;
    expect((await capacity.status()).mode).toBe("failed");
    p.writable = true;
    p.freeBytes = 1400;
    expect((await capacity.status()).mode).toBe("restricted");
    p.freeBytes = 3000;
    p.oldestAgeMs = 100000;
    expect((await capacity.status()).mode).toBe("warning");
    const failure = new Capacity(config, spool, async () => {
      throw Error("EIO");
    });
    expect((await failure.status()).allowedActions).toEqual(["read"]);
  });
  it("不可写的真实路径不返回成功，损坏 spool 不被删除", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyez-storage-fail-")),
      file = join(dir, "not-a-directory");
    await writeFile(file, "occupied");
    const spool = new Spool(file);
    await expect(spool.init()).rejects.toThrow();
    const config = testConfig("postgres://a:b@localhost/d", file);
    expect((await new Capacity(config, spool).status()).mode).toBe("failed");
    const corrupt = new Spool(join(dir, "queue"));
    await corrupt.init();
    await writeFile(join(corrupt.directory, "bad.pending"), "incomplete");
    await expect(corrupt.drain({} as never, "api")).rejects.toMatchObject({
      code: "SPOOL_CORRUPT",
    });
    expect(await readdir(corrupt.directory)).toContain("bad.pending");
  });
});
