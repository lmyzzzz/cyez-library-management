import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { runtimeDatabase } from "../../helpers/runtime-database.js";
import { testConfig, identity } from "../../helpers/config.js";
import { createApp } from "../../../apps/server/src/app.js";
import { AddonRuntime } from "../../../apps/server/src/addons/runtime.js";
import { studentId } from "@record/protocol/identity";
import type { AddonId } from "@record/protocol";
import { SCHEDULER_CLIENT_ID } from "../../../apps/server/src/addons/catalog.js";

describe("真实 PG 受限角色：快捷禁用与内置加载项", () => {
  let fixture: Awaited<ReturnType<typeof runtimeDatabase>>,
    server: Awaited<ReturnType<typeof createApp>>;
  let token: string,
    now: number,
    grade = "I（1班）",
    serial = 100,
    writable = true;
  const at = (time: string) => Date.parse(`2026-11-16T${time}+08:00`);
  const clientId = randomUUID();
  const api = async (
    method: "GET" | "POST" | "PATCH",
    path: string,
    payload?: unknown,
  ) => {
    const result = await server.app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as never,
    });
    return { status: result.statusCode, body: result.json() };
  };
  beforeAll(async () => {
    now = at("12:00:00");
    fixture = await runtimeDatabase();
    server = await createApp(testConfig(fixture.url, fixture.directory), {
      database: fixture.db,
      now: () => now,
      probe: async () => ({ freeBytes: 100000, writable, oldestAgeMs: 0 }),
      provider: {
        lookup: async () => ({
          name: "加载项测试学生",
          className: grade,
          schoolNumber: "",
        }),
      },
    });
    const login = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "teacher-test",
        password: "integration-password-only",
        clientId,
      },
    });
    token = login.json().token;
    await server.addons.close(); // The tests explicitly drive the real scheduler clock.
  });
  beforeEach(async () => {
    now = at("12:00:00");
    writable = true;
    await fixture.owner.audits.destroy({ where: {} });
    await fixture.owner.records.destroy({ where: {} });
    await fixture.owner.operations.destroy({ where: {} });
    await fixture.owner.addons.update(
      {
        enabled: false,
        enabledAt: null,
        lastSlot: null,
        lastRun: null,
        version: 1,
      },
      { where: {} },
    );
  });
  afterAll(async () => {
    await server?.app.close();
    await fixture?.close();
  });
  const enable = async (id: AddonId = "end-grade-1-2") => {
    expect(
      (
        await api("POST", `/addons/${id}/configure`, {
          requestId: randomUUID(),
          expectedVersion: 1,
          enabled: true,
        })
      ).status,
    ).toBe(200);
  };
  const createDevice = async () => {
    const data = {
      requestId: randomUUID(),
      code: `ADDON-${serial++}`,
      displayName: "测试设备",
      notes: "设备备注",
      isDisabled: false,
      tagIds: [],
    };
    const result = await api("POST", "/devices", data);
    expect(result.status).toBe(200);
    return { id: result.body.deviceId as string, data };
  };
  const preview = async (className: string) => {
    grade = className;
    const card = {
      issuer: identity.issuer,
      uidHex: (serial++).toString(16).padStart(8, "0"),
    };
    const result = await api("POST", "/scan-previews", {
      scanId: randomUUID(),
      studentId: studentId(card, identity),
      hashVersion: identity.hashVersion,
      card,
      source: "integration",
    });
    expect(result.status).toBe(200);
    return result.body.id as string;
  };
  const start = async (className: string) => {
    const device = await createDevice(),
      previewId = await preview(className);
    const result = await api("POST", "/usage-records/start", {
      requestId: randomUUID(),
      previewId,
      deviceId: device.id,
      notes: "保留原备注",
    });
    expect(result.status).toBe(200);
    return { ...device, recordId: result.body.recordId as string };
  };
  const row = async (id: string) =>
    (await fixture.db.records.findByPk(id))!.get();

  it("默认禁用、鉴权、配置版本冲突与手动执行幂等", async () => {
    const reserved = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "teacher-test",
        password: "integration-password-only",
        clientId: SCHEDULER_CLIENT_ID,
      },
    });
    expect(reserved.statusCode).toBe(401);
    expect(
      (await server.app.inject({ url: "/api/v1/addons" })).statusCode,
    ).toBe(401);
    expect(
      (await api("GET", "/addons")).body.items.every(
        (x: { enabled: boolean }) => !x.enabled,
      ),
    ).toBe(true);
    expect(
      (
        await api("POST", "/addons/end-grade-1-2/run", {
          requestId: randomUUID(),
        })
      ).body.code,
    ).toBe("ADDON_DISABLED");
    const record = await start("Ⅰ（1班）");
    await enable();
    expect(
      (
        await api("POST", "/addons/end-grade-1-2/configure", {
          requestId: randomUUID(),
          expectedVersion: 1,
          enabled: false,
        })
      ).body.code,
    ).toBe("ADDON_VERSION_CONFLICT");
    now = at("12:01:00");
    const body = { requestId: randomUUID() };
    const [first, duplicate] = await Promise.all([
      api("POST", "/addons/end-grade-1-2/run", body),
      api("POST", "/addons/end-grade-1-2/run", body),
    ]);
    expect(first.body).toEqual({ count: 1 });
    expect(duplicate.body).toEqual(first.body);
    expect(await row(record.recordId)).toMatchObject({
      endedAt: new Date(now),
      version: 2,
      notes: "保留原备注",
      endReason: "batch",
    });
    expect(
      await fixture.owner.audits.count({
        where: { recordId: record.recordId, action: "usage.ended" },
      }),
    ).toBe(1);
    await api("POST", "/addons/end-grade-1-2/configure", {
      requestId: randomUUID(),
      expectedVersion: 2,
      enabled: false,
    });
    expect(
      (
        await api("POST", "/addons/end-grade-1-2/run", {
          requestId: randomUUID(),
        })
      ).body.code,
    ).toBe("ADDON_DISABLED");
  });
  it("12:40 仅结束高一高二，13:30 才结束高三；重复 tick 和新 runtime 不重复结束", async () => {
    const records: Awaited<ReturnType<typeof start>>[] = [];
    for (const label of ["I（1）", "Ⅱ（2）", "III（3）", "VIII（4）", "I II"])
      records.push(await start(label));
    await enable();
    await enable("end-grade-3");
    now = at("12:39:59");
    await server.addons.tick();
    expect(await fixture.db.records.count({ where: { endedAt: null } })).toBe(
      5,
    );
    now = at("12:40:00");
    const restarted = new AddonRuntime(server.service, () => now);
    await Promise.all([server.addons.tick(), restarted.tick()]);
    expect((await row(records[0].recordId)).endedAt).toEqual(new Date(now));
    expect((await row(records[1].recordId)).endedAt).toEqual(new Date(now));
    expect((await row(records[2].recordId)).endedAt).toBeNull();
    now = at("12:41:00");
    const later = await start("I（9）");
    await restarted.tick();
    expect((await row(later.recordId)).endedAt).toBeNull();
    now = at("13:30:00");
    await restarted.tick();
    expect((await row(records[2].recordId)).endedAt).toEqual(new Date(now));
    expect((await row(records[3].recordId)).endedAt).toBeNull();
    expect((await row(records[4].recordId)).endedAt).toBeNull();
  });
  it("容量失败全回滚；恢复后当天补执行只处理截止前已经提交的记录", async () => {
    await enable();
    const earlier = await start("II（1）");
    now = at("12:39:59");
    const oldPreview = await preview("I（2）"),
      device = await createDevice();
    now = at("12:40:00");
    writable = false;
    await server.addons.tick();
    expect((await row(earlier.recordId)).endedAt).toBeNull();
    expect(
      (await fixture.db.addons.findByPk("end-grade-1-2"))!.get().lastSlot,
    ).toBeNull();
    now = at("12:40:30");
    writable = true;
    const late = await api("POST", "/usage-records/start", {
      requestId: randomUUID(),
      previewId: oldPreview,
      deviceId: device.id,
      notes: "",
    });
    expect(late.status).toBe(200);
    const later = await start("I（2）");
    await new AddonRuntime(server.service, () => now).tick();
    expect((await row(earlier.recordId)).endedAt).toEqual(
      new Date(at("12:40:00")),
    );
    expect((await row(later.recordId)).endedAt).toBeNull();
    expect((await row(late.body.recordId)).endedAt).toBeNull();
  });
  it("到期后才启用不追溯；隔天不补旧任务", async () => {
    const record = await start("I（1）");
    now = at("12:41:00");
    await enable();
    await server.addons.tick();
    expect((await row(record.recordId)).endedAt).toBeNull();
    now = Date.parse("2026-11-17T09:00:00+08:00");
    await server.addons.tick();
    expect((await row(record.recordId)).endedAt).toBeNull();
  });
  it("与手动结束并发只结束一次，新记录不受重放影响", async () => {
    const record = await start("II（1）");
    await enable();
    now = at("12:01:00");
    const p = (
      await api("POST", `/usage-records/${record.recordId}/end-preview`, {})
    ).body;
    const [manual, addon] = await Promise.all([
      api("POST", `/usage-records/${record.recordId}/end`, {
        requestId: randomUUID(),
        previewId: p.id,
        expectedVersion: p.record.version,
        notes: "保留原备注",
      }),
      api("POST", "/addons/end-grade-1-2/run", { requestId: randomUUID() }),
    ]);
    expect([200, 409]).toContain(manual.status);
    expect(addon.status).toBe(200);
    expect((await row(record.recordId)).version).toBe(2);
  });
  it("快捷禁用持久幂等、版本校验；占用不能从快捷或编辑接口禁用", async () => {
    const device = await createDevice();
    const body = {
      requestId: randomUUID(),
      expectedVersion: 1,
      isDisabled: true,
    };
    expect(
      (await api("PATCH", `/devices/${device.id}/disabled`, body)).status,
    ).toBe(200);
    expect(
      (await api("PATCH", `/devices/${device.id}/disabled`, body)).body.version,
    ).toBe(2);
    expect(
      (
        await api("PATCH", `/devices/${device.id}/disabled`, {
          ...body,
          requestId: randomUUID(),
        })
      ).body.code,
    ).toBe("DEVICE_VERSION_CONFLICT");
    expect(
      (
        await api("PATCH", `/devices/${device.id}/disabled`, {
          requestId: randomUUID(),
          expectedVersion: 2,
          isDisabled: false,
        })
      ).body.version,
    ).toBe(3);
    const occupied = await start("I（1）");
    expect(
      (await api("PATCH", `/devices/${occupied.id}/disabled`, body)).body.code,
    ).toBe("REQUEST_ID_REUSED");
    expect(
      (
        await api("PATCH", `/devices/${occupied.id}/disabled`, {
          ...body,
          requestId: randomUUID(),
        })
      ).body.code,
    ).toBe("DEVICE_IN_USE");
    expect(
      (
        await api("PATCH", `/devices/${occupied.id}`, {
          ...occupied.data,
          requestId: randomUUID(),
          expectedVersion: 1,
          isDisabled: true,
        })
      ).body.code,
    ).toBe("DEVICE_IN_USE");
    expect((await row(occupied.recordId)).endedAt).toBeNull();
  });
  it("登记与快捷禁用竞争，不能出现禁用且占用的设备", async () => {
    const device = await createDevice(),
      previewId = await preview("I（1）");
    const results = await Promise.all([
      api("PATCH", `/devices/${device.id}/disabled`, {
        requestId: randomUUID(),
        expectedVersion: 1,
        isDisabled: true,
      }),
      api("POST", "/usage-records/start", {
        requestId: randomUUID(),
        previewId,
        deviceId: device.id,
        notes: "",
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const disabled = (await fixture.db.devices.findByPk(device.id))!.get()
      .isDisabled;
    const active = await fixture.db.records.count({
      where: { deviceId: device.id, endedAt: null },
    });
    expect(disabled && active > 0).toBe(false);
  });
});
