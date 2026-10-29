import { describe, it, expect, vi } from "vitest";
import { studentId, identityConfigSchema } from "@record/protocol/identity";
import {
  profileSchema,
  parse,
  normalizePin,
  scanSchema,
  logSchema,
  ApiError,
} from "@record/protocol";
import {
  assertInterval,
  appendBatchNotes,
  assertAssignable,
  canonical,
  payloadDigest,
  SerialKeys,
} from "@record/domain";
import { identity, testConfig } from "../../helpers/config.js";
import { configSchema } from "../../../apps/server/src/config.js";
import { Previews } from "../../../apps/server/src/previews.js";
import { Auth } from "../../../apps/server/src/auth.js";
import {
  refreshProfile,
  FakeProvider,
} from "../../../apps/server/src/provider.js";
import { randomUUID } from "node:crypto";
describe("S-U 共享身份与业务规则", () => {
  it("共享固定长度编码向量，保留前导零；盐/版本/发行方隔离", () => {
    const card = { issuer: identity.issuer, uidHex: "00000001" };
    const expected = studentId(card, identity);
    expect(expected).toBe(
      "c96e294173cabdcfe8509c76ab962499e6e67c459032b1d9dd70183418c2c4d5",
    );
    expect(studentId(card, { ...identity, hashVersion: "v2" })).not.toBe(
      expected,
    );
    expect(
      studentId(card, { ...identity, fixedSaltHex: "11".repeat(16) }),
    ).not.toBe(expected);
    expect(
      studentId(
        { issuer: "other", uidHex: card.uidHex },
        { ...identity, issuer: "other" },
      ),
    ).not.toBe(expected);
    for (const uidHex of ["", "1", "AA000001", "000001", "0g000001"])
      expect(() => studentId({ ...card, uidHex }, identity)).toThrow(
        "CARD_FORMAT_INVALID",
      );
    expect(() => studentId({ ...card, issuer: "other" }, identity)).toThrow();
    expect(() => studentId(card, { ...identity, fixedSaltHex: "z" })).toThrow();
  });
  it("毫秒与区间边界，不接受负时长/非整数", () => {
    assertInterval(100, 100);
    assertInterval(0, 1);
    for (const pair of [
      [-1, 2],
      [2, 1],
      [0, 1.5],
      [0, Infinity],
      [0, Number.MAX_SAFE_INTEGER + 1],
    ])
      expect(() => assertInterval(...(pair as [number, number]))).toThrow(
        "TIME_RANGE_CONFLICT",
      );
  });
  it("备注追加与设备状态", () => {
    expect(appendBatchNotes("原文", "")).toBe("原文");
    expect(appendBatchNotes("", "闭馆")).toBe("批量结束备注：闭馆");
    expect(appendBatchNotes("原文", "闭馆")).toBe("原文\n批量结束备注：闭馆");
    expect(() => appendBatchNotes("a".repeat(8000), "b")).toThrow();
    assertAssignable({ deletedAt: null, isDisabled: false }, false);
    for (const v of [
      { deletedAt: new Date(), isDisabled: false },
      { deletedAt: null, isDisabled: true },
    ])
      expect(() => assertAssignable(v, false)).toThrow();
    expect(() =>
      assertAssignable({ deletedAt: null, isDisabled: false }, true),
    ).toThrow();
  });
  it("摘要排序稳定、路由和 payload 改变均隔离", () => {
    expect(canonical({ b: 2, a: [1, null] })).toBe('{"a":[1,null],"b":2}');
    expect(payloadDigest("/start", { a: 1, b: 2 })).toBe(
      payloadDigest("/start", { b: 2, a: 1 }),
    );
    expect(payloadDigest("/end", { a: 1 })).not.toBe(
      payloadDigest("/start", { a: 1 }),
    );
    expect(canonical(undefined)).toBe("null");
  });
  it("资料、日志严格白名单与无正文校验错误", () => {
    expect(() =>
      parse(profileSchema, {
        name: "学生",
        className: "班",
        schoolNumber: "1",
        uidHex: "00000001",
      }),
    ).toThrow("INPUT_INVALID");
    expect(() => parse(logSchema, { studentId: "secret" })).toThrow(
      "INPUT_INVALID",
    );
    expect(normalizePin("AA:".repeat(31) + "AA")).toBe("aa".repeat(32));
    expect(() => normalizePin("00")).toThrow("PIN_INVALID");
  });
  it("同学生 FIFO，失败释放锁对象，不阻塞下个任务", async () => {
    const serial = new SerialKeys();
    let unlock!: () => void;
    const order: number[] = [];
    const a = serial.run("s", async () => {
      await new Promise<void>((r) => (unlock = r));
      order.push(1);
      throw Error("failed");
    });
    const b = serial.run("s", async () => {
      order.push(2);
      return 2;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(serial.size).toBe(1);
    unlock();
    await expect(a).rejects.toThrow();
    await expect(b).resolves.toBe(2);
    expect(order).toEqual([1, 2]);
    expect(serial.size).toBe(0);
  });
});
describe("S-U 配置、预览与认证", () => {
  it("生产禁止静默 fake 和未确认字段，容量水位有序", () => {
    const c = testConfig("postgres://x:y@localhost/db", "tmp");
    expect(configSchema.safeParse(c).success).toBe(true);
    expect(
      configSchema.safeParse({ ...c, environment: "production" }).success,
    ).toBe(false);
    expect(
      configSchema.safeParse({ ...c, providerMode: "module" }).success,
    ).toBe(false);
    expect(
      configSchema.safeParse({
        ...c,
        capacity: { ...c.capacity, reserveBytes: 999999 },
      }).success,
    ).toBe(false);
  });
  it("预览绑定 client/session、TTL、有界容量", () => {
    let now = 100;
    const previews = new Previews(10, 1, () => now);
    const ctx = {
      clientId: randomUUID(),
      sessionId: "session",
      username: "teacher",
    };
    const p = previews.create(ctx, { mode: "start", atMs: now, records: [] });
    expect(previews.get(p.id, ctx)).toBe(p);
    expect(() => previews.get(p.id, { ...ctx, sessionId: "other" })).toThrow(
      "PREVIEW_FORBIDDEN",
    );
    expect(() =>
      previews.create(ctx, { mode: "start", atMs: now, records: [] }),
    ).toThrow("PREVIEW_CAPACITY");
    now = 110;
    expect(() => previews.get(p.id, ctx)).toThrow("PREVIEW_EXPIRED");
    const next = previews.create(ctx, { mode: "end", atMs: now, records: [] });
    previews.delete(next.id, ctx);
    expect(previews.entries.size).toBe(0);
  });
  it("短期不透明会话绑定 clientId，改密重建旧会话失效", async () => {
    let now = 0;
    const auth = await Auth.create(
      "teacher",
      "a-test-password",
      100,
      () => now,
    );
    await expect(
      auth.login("wrong", "a-test-password", "one"),
    ).rejects.toMatchObject({ status: 401 });
    await expect(auth.login("teacher", "wrong", "one")).rejects.toMatchObject({
      status: 401,
    });
    const result = await auth.login("teacher", "a-test-password", "one");
    expect(auth.require("Bearer " + result.token).clientId).toBe("one");
    expect(() => auth.require(undefined)).toThrow();
    expect(() => auth.require("invalid")).toThrow();
    now = 100;
    expect(() => auth.require("Bearer " + result.token)).toThrow();
    const next = await auth.login("teacher", "a-test-password", "one");
    auth.logout("Bearer " + next.token);
    expect(() => auth.require("Bearer " + next.token)).toThrow();
  });
});
describe("S-U provider 边界", () => {
  it("成功无须回传卡号，失败/超时/取消释放输入，非法字段拒绝", async () => {
    const card = () => ({ issuer: identity.issuer, uidHex: "00000001" });
    const c = card();
    expect((await refreshProfile(new FakeProvider(), c, 100)).name).toBe(
      "集成测试学生",
    );
    expect(c.uidHex).toBe("");
    const bad = card();
    await expect(
      refreshProfile({ lookup: async () => ({ name: "" }) }, bad, 100),
    ).rejects.toMatchObject({ code: "PROFILE_MISMATCH" });
    expect(bad.uidHex).toBe("");
    const timeout = card();
    await expect(
      refreshProfile({ lookup: async () => new Promise(() => {}) }, timeout, 5),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(timeout.uidHex).toBe("");
    const cancelled = card(),
      controller = new AbortController();
    controller.abort();
    await expect(
      refreshProfile(new FakeProvider(), cancelled, 100, controller.signal),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(cancelled.uidHex).toBe("");
  });
});
