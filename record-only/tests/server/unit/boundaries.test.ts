import { afterEach, describe, it, expect, vi } from "vitest";
import {
  mkdtemp,
  writeFile,
  mkdir,
  readdir,
  readFile,
  rename,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, configSchema } from "../../../apps/server/src/config.js";
import {
  loadProvider,
  providerHttpsJson,
  refreshProfile,
} from "../../../apps/server/src/provider.js";
import { Capacity, Spool } from "../../../apps/server/src/storage.js";
import { FileCollector } from "../../../apps/server/src/file-collector.js";
import { cardMatches } from "../../../apps/server/src/provider-sqlserver.js";
import { errorResponse } from "../../../apps/server/src/app.js";
import { Service } from "../../../apps/server/src/service.js";
import {
  ADJACENCY_GRADES,
  ApiError,
  DEFAULT_LAYOUT_SETTINGS,
  adjacencyGradeSchema,
  layoutSettingsSchema,
} from "@record/protocol";
import { studentId } from "@record/protocol/identity";
import type { Database } from "../../../apps/server/src/database.js";
import { testConfig, identity } from "../../helpers/config.js";
function fakeLogDb() {
  const received: string[] = [];
  const unique = new Set<string>();
  const db = {
    sequelize: {
      transaction: async (work: (transaction: object) => Promise<unknown>) =>
        work({}),
    },
    logs: {
      bulkCreate: async (rows: { logId: string }[]) => {
        for (const row of rows) {
          received.push(row.logId);
          unique.add(row.logId);
        }
      },
    },
  } as unknown as Database;
  return { db, received, unique };
}
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
    const fake = await loadProvider(config);
    expect(
      await fake.lookup(
        { issuer: "integration", uidHex: "00000001" },
        new AbortController().signal,
      ),
    ).toMatchObject({ name: "集成测试学生" });
    await expect(
      fake.lookup(
        { issuer: "integration", uidHex: "ffffffff" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("STUDENT_NOT_ALLOWED");
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
  it("不可写的真实路径不返回成功，损坏 spool 隔离后继续归集", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyez-storage-fail-")),
      file = join(dir, "not-a-directory");
    await writeFile(file, "occupied");
    const spool = new Spool(file);
    await expect(spool.init()).rejects.toThrow();
    const config = testConfig("postgres://a:b@localhost/d", file);
    expect((await new Capacity(config, spool).status()).mode).toBe("failed");
    const corrupt = new Spool(join(dir, "queue"));
    await corrupt.init();
    await writeFile(join(corrupt.directory, "a-bad.json"), "incomplete");
    const good = {
      logId: randomUUID(),
      source: "api" as const,
      level: "info" as const,
      atMs: Date.now(),
      appVersion: "0.1.0",
      code: "APP_STARTED" as const,
    };
    await writeFile(
      join(corrupt.directory, "z-good.json"),
      JSON.stringify(good),
    );
    const legacy = { ...good, logId: randomUUID() };
    await writeFile(
      join(corrupt.directory, `${legacy.logId}.json.pending`),
      JSON.stringify(legacy),
    );
    await writeFile(join(corrupt.directory, "bad.pending"), "incomplete");
    const { db, unique } = fakeLogDb();
    await corrupt.drain(db, "api");
    expect([...unique]).toEqual([good.logId, legacy.logId]);
    expect((await corrupt.metrics()).count).toBe(0);
    const names = await readdir(corrupt.directory);
    expect(names).not.toContain("a-bad.json");
    expect(names).not.toContain("z-good.json");
    expect(names).not.toContain("bad.pending");
    expect(names.some((n) => n.startsWith("a-bad.json.corrupt-"))).toBe(true);
    expect(names.some((n) => n.startsWith("bad.pending.corrupt-"))).toBe(true);
    // The quarantined payload is retained for inspection, not silently dropped.
    expect(
      await readFile(
        join(
          corrupt.directory,
          names.find((n) => n.startsWith("a-bad.json.corrupt-"))!,
        ),
        "utf8",
      ),
    ).toBe("incomplete");
  });
  it("append 原子写入，失败时清理临时文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyez-spool-append-")),
      spool = new Spool(dir);
    const log = {
      logId: randomUUID(),
      source: "api" as const,
      level: "info" as const,
      atMs: Date.now(),
      appVersion: "0.1.0",
      code: "APP_STARTED" as const,
    };
    await spool.append(log);
    let names = await readdir(dir);
    expect(names).toContain(`${log.logId}.json`);
    expect(names.filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
    // Force the final rename to fail: the staged temp file must be removed.
    const blockedId = randomUUID();
    await mkdir(join(dir, `${blockedId}.json`));
    await expect(spool.append({ ...log, logId: blockedId })).rejects.toThrow();
    names = await readdir(dir);
    expect(names.filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
    expect(
      names.filter((n) => n.startsWith(`${blockedId}.json.`)),
    ).toHaveLength(0);
  });
});
describe("HTTP 错误语义映射", () => {
  it("已知 ApiError 保留状态，413/429 明确，其余 4xx 归 422，未知/5xx 归 503", () => {
    expect(errorResponse(new ApiError("DEVICE_IN_USE", 409))).toEqual({
      status: 409,
      code: "DEVICE_IN_USE",
    });
    for (const statusCode of [400, 401, 403, 404, 415, 418, 422]) {
      expect(
        errorResponse(Object.assign(Error("request detail"), { statusCode })),
      ).toEqual({ status: 422, code: "INPUT_INVALID" });
    }
    expect(
      errorResponse(
        Object.assign(Error("payload detail"), { statusCode: 413 }),
      ),
    ).toEqual({ status: 413, code: "BODY_TOO_LARGE" });
    expect(
      errorResponse(Object.assign(Error("rate detail"), { statusCode: 429 })),
    ).toEqual({ status: 429, code: "RATE_LIMITED" });
    for (const statusCode of [500, 502, 503]) {
      expect(
        errorResponse(Object.assign(Error("secret detail"), { statusCode })),
      ).toEqual({ status: 503, code: "SERVICE_UNAVAILABLE" });
    }
    const unknown = errorResponse(new Error("secret request body"));
    expect(unknown).toEqual({ status: 503, code: "SERVICE_UNAVAILABLE" });
    expect(JSON.stringify(unknown)).not.toContain("secret");
  });
});
describe("文件采集游标轮转安全", () => {
  it("未变更文件回退重放不重复，截断/轮转后换代号继续归集", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyez-collector-")),
      sourceDir = join(root, "source"),
      cursorDir = join(root, "cursors"),
      source = join(sourceDir, "gateway.jsonl");
    await mkdir(sourceDir);
    await writeFile(source, "a\nb\n");
    const { db, unique } = fakeLogDb();
    const collector = new FileCollector(sourceDir, cursorDir, "gateway");
    await collector.drain(db);
    expect(unique.size).toBe(2);
    const [cursorFile] = await readdir(cursorDir);
    expect(cursorFile).toBeDefined();
    const cursorPath = join(cursorDir, cursorFile);
    expect(JSON.parse(await readFile(cursorPath, "utf8"))).toMatchObject({
      offset: 4,
      generation: 0,
    });
    // Legacy `{offset:0}` rollback replays the same deterministic IDs.
    await writeFile(cursorPath, JSON.stringify({ offset: 0 }));
    await collector.drain(db);
    expect(unique.size).toBe(2);
    // Truncation: shorter file restarts from zero under a new generation.
    await writeFile(source, "c\n");
    await collector.drain(db);
    expect(unique.size).toBe(3);
    expect(JSON.parse(await readFile(cursorPath, "utf8"))).toMatchObject({
      offset: 2,
      generation: 1,
    });
    // Rotation: replacing the inode with a larger file also resets and continues.
    await rename(source, source + ".rotated");
    await writeFile(source, "d\ne\nf\n");
    await collector.drain(db);
    expect(unique.size).toBe(6);
    expect(JSON.parse(await readFile(cursorPath, "utf8"))).toMatchObject({
      offset: 6,
      generation: 2,
    });
    await collector.drain(db);
    expect(unique.size).toBe(6);
  });
  it("损坏游标隔离并换新代号，源文件不被删除", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyez-collector-bad-")),
      sourceDir = join(root, "source"),
      cursorDir = join(root, "cursors"),
      source = join(sourceDir, "db.jsonl");
    await mkdir(sourceDir);
    await writeFile(source, "a\nb\n");
    const { db, unique } = fakeLogDb();
    const collector = new FileCollector(sourceDir, cursorDir, "db");
    await collector.drain(db);
    expect(unique.size).toBe(2);
    const [cursorFile] = await readdir(cursorDir);
    const cursorPath = join(cursorDir, cursorFile);
    // Unparseable cursor: quarantine, restart, and continue.
    await writeFile(cursorPath, "{not-json");
    await collector.drain(db);
    expect(unique.size).toBe(4);
    let names = await readdir(cursorDir);
    expect(names.some((n) => n.startsWith(`${cursorFile}.corrupt-`))).toBe(
      true,
    );
    expect(names).toContain(cursorFile);
    // Parseable but invalid offset: salvage generation and restart as well.
    await writeFile(cursorPath, JSON.stringify({ offset: -2, generation: 3 }));
    await collector.drain(db);
    expect(unique.size).toBe(6);
    names = await readdir(cursorDir);
    expect(
      names.filter((n) => n.startsWith(`${cursorFile}.corrupt-`)),
    ).toHaveLength(2);
    expect(JSON.parse(await readFile(cursorPath, "utf8"))).toMatchObject({
      offset: 4,
      generation: 4,
    });
    expect(await readFile(source, "utf8")).toBe("a\nb\n");
  });
});
describe("SQL Server 卡号列兼容", () => {
  it("接受字符串或数值卡号并保持大小写不敏感比较", () => {
    expect(cardMatches("0000000A", "0000000a")).toBe(true);
    expect(cardMatches(1, "1")).toBe(true);
    expect(cardMatches(4294967295, "4294967295")).toBe(true);
    expect(cardMatches("00000001", "00000002")).toBe(false);
    expect(cardMatches(null, "1")).toBe(false);
    expect(cardMatches({}, "1")).toBe(false);
    expect(cardMatches(Number.NaN, "NaN")).toBe(false);
  });
});
describe("通用操作审计与 provider 健康", () => {
  function serviceDb(audits: Record<string, unknown>[]) {
    return {
      sequelize: {
        transaction: async (work: (tx: object) => Promise<unknown>) =>
          work({ LOCK: { UPDATE: "UPDATE" } }),
      },
      operations: { findOne: async () => null, create: async () => {} },
      audits: {
        create: async (values: Record<string, unknown>) => {
          audits.push(values);
        },
      },
      logs: { create: async () => {} },
      students: { findByPk: async () => null },
    } as unknown as Database;
  }
  function service(db: Database, provider: { lookup: () => Promise<unknown> }) {
    return new Service(
      db,
      testConfig("postgres://a:b@localhost/d", "unused"),
      provider,
      { require: async () => {} } as unknown as Capacity,
      () => 1,
    );
  }
  it("operation 解析器把业务 ID 写入审计且请求 ID 不被覆盖", async () => {
    const audits: Record<string, unknown>[] = [];
    const serviceUnderTest = service(serviceDb(audits), {
      lookup: async () => ({ name: "x", className: "", schoolNumber: "" }),
    });
    const requestId = randomUUID();
    await serviceUnderTest.operation(
      { username: "teacher", clientId: randomUUID(), sessionId: randomUUID() },
      "device.create:",
      { requestId },
      "modify",
      async () => ({ deviceId: "device-1" }),
      (result) => ({
        deviceId: (result as { deviceId?: string }).deviceId,
      }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      requestId,
      deviceId: "device-1",
      action: "device.create:",
      fields: [],
    });
    // audit_events has no tag column, so a tag ID must never be smuggled into
    // the row through an unchecked cast.
    expect(audits[0]).not.toHaveProperty("tagId");
  });
  it("provider 明确拒绝/资料错配视为可连通，仅不可用标记故障", async () => {
    let mode: "mismatch" | "unavailable" = "mismatch";
    const serviceUnderTest = service(serviceDb([]), {
      lookup: async () => {
        if (mode === "mismatch") throw new ApiError("PROFILE_MISMATCH", 422);
        throw new ApiError("PROVIDER_UNAVAILABLE", 503);
      },
    });
    const uidHex = "00000001";
    const card = () => ({ issuer: identity.issuer, uidHex });
    const ctx = {
      username: "teacher",
      clientId: randomUUID(),
      sessionId: randomUUID(),
    };
    const input = () => ({
      scanId: randomUUID(),
      studentId: studentId(card(), identity),
      hashVersion: identity.hashVersion,
      card: card(),
      source: "integration" as const,
    });
    await expect(serviceUnderTest.scan(ctx, input())).rejects.toMatchObject({
      code: "PROFILE_MISMATCH",
    });
    expect(serviceUnderTest.providerHealthy).toBe(true);
    mode = "unavailable";
    await expect(serviceUnderTest.scan(ctx, input())).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(serviceUnderTest.providerHealthy).toBe(false);
  });
});

describe("相邻试验组：布局设置 schema 边界", () => {
  // 纯 protocol 校验：不连数据库、不依赖 domain 算法，判断只看 safeParse().success，
  // 不断言任何具体错误文案。
  const valid = {
    section1Start: 1,
    section1End: 8,
    section2Start: 31,
    section3Start: 41,
    allowCrossArea: true,
    batchWindowSec: 10,
    batchStudentLimit: 8,
  };
  // 同一份底盘，逐项替换某个字段；section3Start 保持 41 这个合法值，
  // 使每次 safeParse 的成败只由被测字段决定。
  const cases = (patch: Record<string, unknown>) =>
    layoutSettingsSchema.safeParse({ ...valid, ...patch });
  it("默认值常量与冻结稿的分界点、批次默认值一致", () => {
    expect(DEFAULT_LAYOUT_SETTINGS).toEqual(valid);
  });
  it("冻结稿 §4 的默认分界点 S3=41 被 schema 接受", () => {
    // S3 必须落在四角桌起点网格 (x − 41) % 4 === 0 上，41 是网格起点。
    expect(cases({ section3Start: 41 }).success).toBe(true);
    expect(cases({ section3Start: 45 }).success).toBe(true);
  });
  it("非法分界点、窗口与人数上限被拒绝", () => {
    // 6 不是 4 的倍数；40 不是偶数且低于 41 下限；9 秒短于 10 秒下限。
    expect(cases({ section1End: 6 }).success).toBe(false);
    expect(cases({ section3Start: 40 }).success).toBe(false);
    expect(cases({ batchWindowSec: 9 }).success).toBe(false);
    expect(cases({ batchStudentLimit: 1 }).success).toBe(false);
  });
  it("合法边界值被接受", () => {
    for (const patch of [
      { section1End: 8 },
      // 42 曾是“偶数即可”下的合法值，但区域三必须从完整桌子的第一个角开始，
      // 42 会让第一张桌只剩 42/43/44 三个角；网格改为 (x − 41) % 4 === 0 后
      // 最近的合法邻值是 45，因此这里用 45 覆盖“非默认合法值”这一维度。
      { section3Start: 45 },
      { batchWindowSec: 600 },
      { batchStudentLimit: 12 },
      { section1Start: 11 },
      { section2Start: 51 },
    ])
      expect(cases(patch).success).toBe(true);
    // 42 现为非法值，单独固定，防止回退到旧规则。
    expect(cases({ section3Start: 42 }).success).toBe(false);
  });
  it("非整数、超出区间、类型不符与未知字段被拒绝", () => {
    for (const patch of [
      { section1End: 6.5 },
      { section1End: 2 },
      { section1End: 4 },
      { section1End: 100 },
      { section3Start: 9962 },
      { section3Start: 43 },
      { batchWindowSec: 601 },
      { batchWindowSec: 10.5 },
      { batchStudentLimit: 13 },
      { batchStudentLimit: 2.5 },
      { section1Start: 0 },
      { section1Start: 1001 },
      { section2Start: 1 },
      { section2Start: 1001 },
      { allowCrossArea: "true" },
      { uid: "00000001" },
    ])
      expect(cases(patch).success).toBe(false);
  });
});
describe("相邻试验组：错误码与等级常量", () => {
  it("等级数组顺序即优先序，枚举只接受六个固定值", () => {
    // docs/adjacent-layout.md §1.2/§2 最终版：degraded（面对面/斜对角/绕到对面，
    // 都看不见对方屏幕）落在 fair 与 clustered 之间。
    expect(ADJACENCY_GRADES).toEqual([
      "excellent",
      "good",
      "fair",
      "degraded",
      "clustered",
      "scattered",
    ]);
    for (const grade of ADJACENCY_GRADES)
      expect(adjacencyGradeSchema.safeParse(grade).success).toBe(true);
    for (const value of ["best", "Excellent", ""])
      expect(adjacencyGradeSchema.safeParse(value).success).toBe(false);
  });
  it("新增错误码原样透出 HTTP 映射，不夹带卡号字段", () => {
    for (const [code, status] of [
      ["DEVICE_CAPACITY_INSUFFICIENT", 409],
      ["EXPERIMENT_GROUP_DISABLED", 422],
      ["BATCH_FULL", 409],
      ["BATCH_CLOSED", 409],
      ["BATCH_NOT_FOUND", 404],
      ["LAYOUT_VERSION_CONFLICT", 409],
      ["DEVICE_GEOMETRY_INVALID", 422],
    ] as const) {
      const error = new ApiError(code, status);
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(errorResponse(error)).toEqual({ status, code });
      expect(JSON.stringify(errorResponse(error))).not.toContain("uidHex");
    }
  });
});
