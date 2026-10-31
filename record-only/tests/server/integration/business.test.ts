import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../../apps/server/src/database.js";
import { createApp } from "../../../apps/server/src/app.js";
import {
  seedStudents,
  integrationSeed,
} from "../../../apps/server/src/seed.js";
import { testConfig, identity } from "../../helpers/config.js";
import { studentId } from "@record/protocol/identity";
import { ApiError } from "@record/protocol";
import type { Config } from "../../../apps/server/src/config.js";
import type { CampusProvider } from "../../../apps/server/src/provider.js";
import { ingestLogs, Spool } from "../../../apps/server/src/storage.js";
describe("真实 PostgreSQL：登记、并发、幂等及故障", () => {
  let server: Awaited<ReturnType<typeof createApp>>,
    admin: Database,
    config: Config,
    token: string,
    token2: string;
  const clientId = randomUUID(),
    client2 = randomUUID();
  let calls = 0,
    fail = false;
  let profileName = "测试学生";
  let probe = { freeBytes: 100000, writable: true, oldestAgeMs: 0 };
  const provider: CampusProvider = {
    async lookup(card) {
      calls++;
      expect(card.uidHex).toMatch(/^(?:[0-9a-f]{2}){4}$/);
      if (fail) throw Error("provider unreachable");
      if (card.uidHex === "eeeeeeee")
        throw new ApiError("STUDENT_NOT_ALLOWED", 403);
      return { name: profileName, className: "集成一班", schoolNumber: "T001" };
    },
  };
  const databaseName = "cyez_test_" + randomUUID().replaceAll("-", "");
  beforeAll(async () => {
    const adminUrl =
      process.env.TEST_DATABASE_URL ??
      "postgres://cyez_test:integration-only@127.0.0.1:55432/cyez_test";
    admin = new Database(adminUrl);
    await admin.sequelize.getQueryInterface().createDatabase(databaseName);
    const url = new URL(adminUrl);
    url.pathname = "/" + databaseName;
    config = testConfig(
      url.toString(),
      await mkdtemp(join(tmpdir(), "cyez-spool-")),
    );
    const db = new Database(config.databaseUrl);
    await db.migrator.up();
    await db.migrator.up();
    await seedStudents(db, integrationSeed(identity), identity);
    server = await createApp(config, {
      database: db,
      provider,
      probe: async () => probe,
    });
    token = await login(clientId);
    token2 = await login(client2);
  });
  afterAll(async () => {
    await server?.app.close();
    if (admin) {
      await admin.sequelize.getQueryInterface().dropDatabase(databaseName);
      await admin.close();
    }
  });
  async function login(id = clientId, password = config.password) {
    const r = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: config.username, password, clientId: id },
    });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  }
  async function api(
    method: "POST" | "GET" | "PATCH" | "DELETE",
    path: string,
    payload?: unknown,
    auth = token,
  ) {
    const r = await server.app.inject({
      method,
      url: "/api/v1" + path,
      headers: { authorization: "Bearer " + auth },
      payload: payload as never,
    });
    return { status: r.statusCode, body: r.json() };
  }
  async function scan(
    uidHex = "00000001",
    auth = token,
    scanId = randomUUID(),
  ) {
    const r = await api(
      "POST",
      "/scan-previews",
      {
        scanId,
        studentId: studentId({ issuer: identity.issuer, uidHex }, identity),
        hashVersion: "v1",
        card: { issuer: identity.issuer, uidHex },
        source: "integration",
      },
      auth,
    );
    return r;
  }
  async function device(code = randomUUID()) {
    const r = await api("POST", "/devices", {
      requestId: randomUUID(),
      code,
      displayName: "测试电脑",
      notes: "",
      isDisabled: false,
      tagIds: [],
    });
    expect(r.status).toBe(200);
    return r.body.deviceId as string;
  }
  async function start(uidHex: string, deviceId: string) {
    const p = await scan(uidHex);
    expect(p.status).toBe(200);
    const r = await api("POST", "/usage-records/start", {
      requestId: randomUUID(),
      previewId: p.body.id,
      deviceId,
      notes: "原有备注",
    });
    expect(r.status).toBe(200);
    return r.body.recordId as string;
  }
  async function end(recordId: string) {
    const p = await api("POST", `/usage-records/${recordId}/end-preview`, {});
    expect(p.status).toBe(200);
    return api("POST", `/usage-records/${recordId}/end`, {
      requestId: randomUUID(),
      previewId: p.body.id,
      expectedVersion: p.body.record.version,
      notes: p.body.record.notes,
    });
  }
  it("S-I-07/14: API 成功创建缓存，拒绝不创建，错配 ID 不调用 provider", async () => {
    const before = calls;
    const newId = studentId(
      { issuer: identity.issuer, uidHex: "ffffffff" },
      identity,
    );
    expect(await server.db.students.findByPk(newId)).toBeNull();
    const first = await scan("ffffffff");
    expect(first.status).toBe(200);
    expect(first.body.student.id).toBe(newId);
    expect(JSON.stringify(first.body)).not.toContain("uidHex");
    expect((await server.db.students.findByPk(newId))?.get().name).toBe(
      profileName,
    );
    const bad = await api("POST", "/scan-previews", {
      scanId: randomUUID(),
      studentId: "0".repeat(64),
      hashVersion: "v1",
      card: { issuer: identity.issuer, uidHex: "00000001" },
      source: "integration",
    });
    expect(bad.body).toEqual({ code: "CARD_ID_MISMATCH" });
    const deniedId = studentId(
      { issuer: identity.issuer, uidHex: "eeeeeeee" },
      identity,
    );
    expect((await scan("eeeeeeee")).body.code).toBe("STUDENT_NOT_ALLOWED");
    expect(await server.db.students.findByPk(deniedId)).toBeNull();
    expect(
      (await api("GET", "/service-status")).body.reasonCodes,
    ).not.toContain("PROVIDER_UNAVAILABLE");
    expect(calls).toBe(before + 2);
  });
  it("S-I-06: 刷卡刷新独立提交、重复 scan 去重、每次新刷卡刷新", async () => {
    const scanId = randomUUID(),
      before = calls;
    const p = await scan("00000001", token, scanId);
    expect(p.status).toBe(200);
    expect(JSON.stringify(p.body)).not.toContain("uidHex");
    expect((await scan("00000001", token, scanId)).body).toEqual(p.body);
    expect(calls).toBe(before + 1);
    await api("DELETE", `/scan-previews/${p.body.id}`);
    profileName = "刷新后的姓名";
    const second = await scan();
    expect(second.body.student.name).toBe(profileName);
    expect(calls).toBe(before + 2);
    expect(await server.db.students.count()).toBe(4);
  });
  it("S-I-06/07/11: 故障刷卡同键缓存拒绝，活动学生再刷卡生成结束意图", async () => {
    const failedScanId = randomUUID();
    const cachedId = studentId(
      { issuer: identity.issuer, uidHex: "00000003" },
      identity,
    );
    const cachedBefore = (await server.db.students.findByPk(cachedId))!.get();
    fail = true;
    const before = calls;
    expect((await scan("00000003", token, failedScanId)).body.code).toBe(
      "PROVIDER_UNAVAILABLE",
    );
    expect((await scan("00000003", token, failedScanId)).body.code).toBe(
      "PROVIDER_UNAVAILABLE",
    );
    expect(calls).toBe(before + 1);
    expect((await server.db.students.findByPk(cachedId))!.get()).toMatchObject({
      name: cachedBefore.name,
      version: cachedBefore.version,
    });
    const uncachedId = studentId(
      { issuer: identity.issuer, uidHex: "eeeeeeef" },
      identity,
    );
    expect((await scan("eeeeeeef")).body.code).toBe("PROVIDER_UNAVAILABLE");
    expect(await server.db.students.findByPk(uncachedId)).toBeNull();
    fail = false;
    const recordId = await start("00000003", await device());
    const preview = await scan("00000003");
    expect(preview.status).toBe(200);
    expect(preview.body.mode).toBe("end");
    expect(preview.body.record.id).toBe(recordId);
    const result = await api("POST", `/usage-records/${recordId}/end`, {
      requestId: randomUUID(),
      previewId: preview.body.id,
      expectedVersion: preview.body.record.version,
      notes: "刷卡结束",
    });
    expect(result.status).toBe(200);
    expect((await server.db.records.findByPk(recordId))!.get().endReason).toBe(
      "scan",
    );
  });
  it("S-I-01/02/11: 两客户端抢同机，唯一占用与一次消费，设备软删除保护", async () => {
    const id = await device();
    const p1 = await scan("00000001"),
      p2 = await scan("00000002", token2);
    const inputs = [
      {
        requestId: randomUUID(),
        previewId: p1.body.id,
        deviceId: id,
        notes: "",
      },
      {
        requestId: randomUUID(),
        previewId: p2.body.id,
        deviceId: id,
        notes: "",
      },
    ];
    const results = await Promise.all([
      api("POST", "/usage-records/start", inputs[0]),
      api("POST", "/usage-records/start", inputs[1], token2),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results[0].status === 200 ? 0 : 1;
    const auth = winner ? token2 : token;
    expect(
      (await api("POST", "/usage-records/start", inputs[winner], auth)).body,
    ).toEqual(results[winner].body);
    expect(
      (
        await api(
          "POST",
          "/usage-records/start",
          { ...inputs[winner], requestId: randomUUID() },
          auth,
        )
      ).body.code,
    ).toBe("PREVIEW_ALREADY_USED");
    expect(
      (
        await api("DELETE", "/devices/" + id, {
          requestId: randomUUID(),
          expectedVersion: 1,
        })
      ).body.code,
    ).toBe("DEVICE_IN_USE");
    expect((await end(results[winner].body.recordId)).status).toBe(200);
    expect(
      (
        await api("DELETE", "/devices/" + id, {
          requestId: randomUUID(),
          expectedVersion: 1,
        })
      ).status,
    ).toBe(200);
    expect(await server.db.records.count({ where: { deviceId: id } })).toBe(1);
  });
  it("S-I-04/07: provider 故障不覆盖资料，手动结束可用，历史不可修改", async () => {
    const id = await start("00000001", await device());
    const before = (await server.db.students.findByPk(
      studentId({ issuer: identity.issuer, uidHex: "00000001" }, identity),
    ))!.get();
    fail = true;
    expect((await scan()).body.code).toBe("PROVIDER_UNAVAILABLE");
    expect((await server.db.students.findByPk(before.id))!.get().version).toBe(
      before.version,
    );
    expect((await end(id)).status).toBe(200);
    fail = false;
    expect(
      (
        await api("PATCH", `/usage-records/${id}/notes`, {
          requestId: randomUUID(),
          expectedVersion: 2,
          notes: "不允许",
        })
      ).body.code,
    ).toBe("HISTORY_READ_ONLY");
    const beforeCalls = calls;
    const history = await api("GET", "/usage-records");
    expect(history.status).toBe(200);
    expect(calls).toBe(beforeCalls);
    expect(
      history.body.items.find((r: { id: string }) => r.id === id).student.name,
    ).toBe(profileName);
    expect((await api("DELETE", `/usage-records/${id}`, {})).status).toBe(404);
  });
  it("S-I-05: 批量固定集合，单条冲突整批回滚，追加备注只一次", async () => {
    const a = await start("00000001", await device()),
      b = await start("00000002", await device());
    const preview = await api("POST", "/usage-records/end-batches/preview", {
      scope: "all",
    });
    const c = await start("00000003", await device());
    await api("PATCH", `/usage-records/${b}/notes`, {
      requestId: randomUUID(),
      expectedVersion: 1,
      notes: "并发编辑",
    });
    expect(
      (
        await api("POST", "/usage-records/end-batches/confirm", {
          requestId: randomUUID(),
          previewId: preview.body.units[0].id,
          notes: "闭馆",
        })
      ).status,
    ).toBe(409);
    expect((await server.db.records.findByPk(a))!.get().endedAt).toBeNull();
    const selected = await api("POST", "/usage-records/end-batches/preview", {
      scope: "selected",
      recordIds: [a, b],
    });
    const payload = {
      requestId: randomUUID(),
      previewId: selected.body.units[0].id,
      notes: "闭馆",
    };
    expect(
      (await api("POST", "/usage-records/end-batches/confirm", payload)).status,
    ).toBe(200);
    expect(
      (await api("POST", "/usage-records/end-batches/confirm", payload)).status,
    ).toBe(200);
    expect((await server.db.records.findByPk(b))!.get().notes).toBe(
      "并发编辑\n批量结束备注：闭馆",
    );
    expect((await server.db.records.findByPk(c))!.get().endedAt).toBeNull();
    await end(c);
  });
  it("S-I-12: 旧刷卡时间与资料版本冲突，失败不消费意图", async () => {
    const id = await device(),
      active = await start("00000002", id);
    const old = await scan("00000001");
    await end(active);
    expect(
      (
        await api("POST", "/usage-records/start", {
          requestId: randomUUID(),
          previewId: old.body.id,
          deviceId: id,
          notes: "",
        })
      ).body.code,
    ).toBe("TIME_RANGE_CONFLICT");
    const stale = await scan();
    await scan();
    expect(
      (
        await api("POST", "/usage-records/start", {
          requestId: randomUUID(),
          previewId: stale.body.id,
          deviceId: id,
          notes: "",
        })
      ).body.code,
    ).toBe("PROFILE_VERSION_CONFLICT");
  });
  it("S-I-09/16/17: 持久日志去重、容量限制与恢复，读服务仍可用", async () => {
    const log = {
      logId: randomUUID(),
      source: "main" as const,
      level: "info" as const,
      atMs: Date.now(),
      appVersion: "0.1.0",
      code: "APP_STARTED" as const,
    };
    await api("POST", "/logs/batch", { logs: [log] });
    await api("POST", "/logs/batch", { logs: [log] });
    expect(
      await server.db.logs.count({
        where: { origin: clientId, logId: log.logId },
      }),
    ).toBe(1);
    expect(
      (
        await api("POST", "/logs/batch", {
          logs: [{ ...log, studentId: "0".repeat(64) }],
        })
      ).status,
    ).toBe(422);
    const spool = new Spool(config.spoolDir);
    await spool.drain(server.db, "api");
    await spool.append({ ...log, logId: randomUUID(), source: "api" });
    expect((await spool.metrics()).count).toBe(1);
    await spool.drain(server.db, "api");
    expect((await spool.metrics()).count).toBe(0);
    const id = await start("00000001", await device());
    probe = { ...probe, freeBytes: 400 };
    expect((await api("GET", "/service-status")).body.allowedActions).toEqual([
      "read",
      "end",
    ]);
    expect((await scan()).status).toBe(503);
    expect((await end(id)).status).toBe(200);
    expect((await api("GET", "/devices")).status).toBe(200);
    probe = { ...probe, writable: false };
    expect((await api("GET", "/service-status")).body.mode).toBe("failed");
    probe = { freeBytes: 100000, writable: true, oldestAgeMs: 0 };
    expect((await api("GET", "/service-status")).body.mode).toBe("normal");
  });
  it("S-I-18: seed 重复不覆盖刷新资料；冲突整批回滚，identity 不能随意改盐", async () => {
    expect(
      (await seedStudents(server.db, integrationSeed(identity), identity))
        .inserted,
    ).toBe(0);
    const altered = integrationSeed(identity);
    altered.students[0].profile.name = "不应覆盖";
    await expect(
      seedStudents(server.db, altered, identity),
    ).rejects.toMatchObject({ code: "SEED_CONFLICT" });
    await expect(
      seedStudents(server.db, integrationSeed(identity), {
        ...identity,
        fixedSaltHex: "11".repeat(16),
      }),
    ).rejects.toMatchObject({ code: "IDENTITY_CONFIGURATION_CHANGED" });
  });
  it("S-I-03/13: API 重建、旧口令/token 失效，跨会话查询原持久结果", async () => {
    const id = await device();
    const p = await scan();
    const payload = {
      requestId: randomUUID(),
      previewId: p.body.id,
      deviceId: id,
      notes: "response lost",
    };
    const result = await api("POST", "/usage-records/start", payload);
    expect(result.status).toBe(200);
    await server.app.close();
    config = { ...config, password: "new-integration-password" };
    server = await createApp(config, { provider, probe: async () => probe });
    expect((await api("GET", "/devices")).status).toBe(401);
    const old = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: config.username,
        password: "integration-password-only",
        clientId,
      },
    });
    expect(old.statusCode).toBe(401);
    token = await login();
    expect(
      (await api("GET", `/operations/${payload.requestId}`)).body.result,
    ).toEqual(result.body);
    expect((await api("POST", "/usage-records/start", payload)).body).toEqual(
      result.body,
    );
    expect(
      (
        await api("POST", "/usage-records/start", {
          ...payload,
          notes: "changed",
        })
      ).body.code,
    ).toBe("REQUEST_ID_REUSED");
    await end(result.body.recordId);
  });
  it("S-I-02/08: 设备与标签完整 CRUD、版本冲突和名称/标签筛选", async () => {
    const tag = (
      await api("POST", "/tags", { requestId: randomUUID(), name: "测试区域" })
    ).body.tagId;
    expect(
      (
        await api("PATCH", `/tags/${tag}`, {
          requestId: randomUUID(),
          name: "测试区域二",
          expectedVersion: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api("PATCH", `/tags/${tag}`, {
          requestId: randomUUID(),
          name: "旧版本",
          expectedVersion: 1,
        })
      ).status,
    ).toBe(409);
    const body = {
      requestId: randomUUID(),
      code: "FILTER-DEVICE",
      displayName: "筛选设备",
      notes: "设备说明",
      isDisabled: false,
      tagIds: [tag],
    };
    const created = await api("POST", "/devices", body);
    const deviceId = created.body.deviceId;
    expect(created.status).toBe(200);
    expect(
      (await api("POST", "/devices", { ...body, requestId: randomUUID() }))
        .status,
    ).toBe(409);
    expect(
      (await api("GET", `/devices?tagId=${tag}&search=FILTER&state=free`)).body
        .total,
    ).toBe(1);
    const patch = {
      ...body,
      requestId: randomUUID(),
      expectedVersion: 1,
      isDisabled: true,
    };
    expect((await api("PATCH", `/devices/${deviceId}`, patch)).status).toBe(
      200,
    );
    expect(
      (
        await api("PATCH", `/devices/${deviceId}`, {
          ...patch,
          requestId: randomUUID(),
        })
      ).body.code,
    ).toBe("DEVICE_VERSION_CONFLICT");
    const p = await scan();
    expect(
      (
        await api("POST", "/usage-records/start", {
          requestId: randomUUID(),
          previewId: p.body.id,
          deviceId,
          notes: "",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await api("PATCH", `/devices/${deviceId}`, {
          ...patch,
          requestId: randomUUID(),
          expectedVersion: 2,
          isDisabled: false,
        })
      ).status,
    ).toBe(200);
    const recordId = await start("00000001", deviceId);
    expect(
      (
        await api(
          "GET",
          `/usage-records?state=active&tagId=${tag}&deviceSearch=FILTER&search=${encodeURIComponent(profileName)}&from=0&to=${Date.now() + 10000}`,
        )
      ).body.total,
    ).toBe(1);
    const filtered = await api("POST", "/usage-records/end-batches/preview", {
      scope: "filtered",
      filter: { deviceSearch: "FILTER", tagId: tag },
    });
    expect(filtered.body.total).toBe(1);
    await api("POST", "/usage-records/end-batches/confirm", {
      requestId: randomUUID(),
      previewId: filtered.body.units[0].id,
      notes: "",
    });
    expect((await server.db.records.findByPk(recordId))!.get().notes).toBe(
      "原有备注",
    );
    expect(
      (await api("GET", `/usage-records?deviceId=${deviceId}&state=ended`)).body
        .total,
    ).toBe(1);
    expect(
      (
        await api("DELETE", `/tags/${tag}`, {
          requestId: randomUUID(),
          expectedVersion: 2,
        })
      ).status,
    ).toBe(200);
    expect(await server.db.links.count({ where: { tagId: tag } })).toBe(0);
    expect(
      (await api("GET", "/tags")).body.items.some(
        (t: { id: string }) => t.id === tag,
      ),
    ).toBe(false);
    expect(
      (
        await api("POST", "/devices", {
          ...body,
          requestId: randomUUID(),
          code: "NEW-CODE",
        })
      ).body.code,
    ).toBe("TAG_NOT_FOUND");
    expect(
      (
        await api("DELETE", `/devices/${deviceId}`, {
          requestId: randomUUID(),
          expectedVersion: 3,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api("PATCH", `/devices/${deviceId}`, {
          ...patch,
          requestId: randomUUID(),
          expectedVersion: 4,
        })
      ).status,
    ).toBe(404);
  });
  it("S-I-05/08/11: 固定分批、绑定错误、无效作用域和记录版本拒绝", async () => {
    const ids = [];
    for (const uid of ["00000001", "00000002", "00000003"])
      ids.push(await start(uid, await device()));
    const batch = await api("POST", "/usage-records/end-batches/preview", {
      scope: "all",
    });
    expect(
      batch.body.units.map((u: { records: unknown[] }) => u.records.length),
    ).toEqual([2, 1]);
    const manual = await api(
      "POST",
      `/usage-records/${ids[0]}/end-preview`,
      {},
    );
    expect(
      (
        await api("POST", "/usage-records/start", {
          requestId: randomUUID(),
          previewId: manual.body.id,
          deviceId: randomUUID(),
          notes: "",
        })
      ).body.code,
    ).toBe("PREVIEW_MODE_INVALID");
    expect(
      (
        await api("POST", `/usage-records/${ids[0]}/end`, {
          requestId: randomUUID(),
          previewId: manual.body.id,
          expectedVersion: 2,
          notes: "",
        })
      ).body.code,
    ).toBe("PREVIEW_MODE_INVALID");
    expect(
      (
        await api("PATCH", `/usage-records/${ids[0]}/notes`, {
          requestId: randomUUID(),
          expectedVersion: 99,
          notes: "",
        })
      ).body.code,
    ).toBe("RECORD_VERSION_CONFLICT");
    for (const unit of batch.body.units)
      expect(
        (
          await api("POST", "/usage-records/end-batches/confirm", {
            requestId: randomUUID(),
            previewId: unit.id,
            notes: "",
          })
        ).status,
      ).toBe(200);
    expect(
      (await api("POST", `/usage-records/${ids[0]}/end-preview`, {})).body.code,
    ).toBe("HISTORY_READ_ONLY");
    for (const path of [`/usage-records/${randomUUID()}/end-preview`])
      expect((await api("POST", path, {})).status).toBe(404);
    expect(
      (
        await api("POST", "/usage-records/end-batches/preview", {
          scope: "selected",
          recordIds: [randomUUID()],
        })
      ).status,
    ).toBe(409);
    for (const payload of [
      { scope: "selected" },
      { scope: "all", recordIds: [randomUUID()] },
      { scope: "selected", recordIds: [randomUUID()], filter: { search: "x" } },
    ])
      expect(
        (await api("POST", "/usage-records/end-batches/preview", payload))
          .status,
      ).toBe(422);
    const p = await scan(),
      other = await login(client2);
    expect(
      (
        await api(
          "POST",
          "/usage-records/start",
          {
            requestId: randomUUID(),
            previewId: p.body.id,
            deviceId: await device(),
            notes: "",
          },
          other,
        )
      ).status,
    ).toBe(403);
    await api("DELETE", `/scan-previews/${p.body.id}`);
    expect(
      (
        await api("POST", "/usage-records/start", {
          requestId: randomUUID(),
          previewId: p.body.id,
          deviceId: randomUUID(),
          notes: "",
        })
      ).status,
    ).toBe(410);
  });
  it("S-I-12: provider 查询期间缓存变化不得覆盖，刷新队列顺序可验证", async () => {
    const original = provider.lookup;
    const sid = studentId(
      { issuer: identity.issuer, uidHex: "00000001" },
      identity,
    );
    let enter!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((r) => (enter = r)),
      finishPromise = new Promise<void>((r) => (finish = r));
    provider.lookup = async () => {
      enter();
      await finishPromise;
      return { name: "不应写入", className: "班", schoolNumber: "N" };
    };
    try {
      const version = (await server.db.students.findByPk(sid))!.get().version;
      const request = scan();
      await entered;
      await server.db.students.update(
        { name: "并发更新", version: version + 1 },
        { where: { id: sid } },
      );
      finish();
      expect((await request).body.code).toBe("PROFILE_VERSION_CONFLICT");
      expect((await server.db.students.findByPk(sid))!.get().name).toBe(
        "并发更新",
      );
    } finally {
      provider.lookup = original;
    }
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const sequence: number[] = [];
    let started!: () => void;
    const starting = new Promise<void>((r) => (started = r));
    provider.lookup = async () => {
      const index = sequence.length;
      sequence.push(index);
      if (index === 0) {
        started();
        await hold;
      }
      return { name: `顺序${index}`, className: "班", schoolNumber: "N" };
    };
    try {
      const first = scan();
      await starting;
      const second = scan();
      await new Promise((r) => setTimeout(r, 15));
      expect(sequence).toEqual([0]);
      release();
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
      expect((await server.db.students.findByPk(sid))!.get().name).toBe(
        "顺序1",
      );
    } finally {
      provider.lookup = original;
    }
  });
  it("S-I-08/14: schema/version/source/限流/孤儿外键均有实际拒绝", async () => {
    const base = {
      scanId: randomUUID(),
      studentId: studentId(
        { issuer: identity.issuer, uidHex: "00000001" },
        identity,
      ),
      hashVersion: "v1",
      card: { issuer: identity.issuer, uidHex: "00000001" },
      source: "integration",
    };
    expect(
      (await api("POST", "/scan-previews", { ...base, hashVersion: "v2" })).body
        .code,
    ).toBe("HASH_VERSION_UNSUPPORTED");
    expect(
      (
        await api("POST", "/scan-previews", {
          ...base,
          card: { ...base.card, issuer: "other" },
        })
      ).body.code,
    ).toBe("CARD_FORMAT_INVALID");
    const preview = await api("POST", "/scan-previews", base);
    expect(preview.status).toBe(200);
    const uidHex = "00000002";
    expect(
      (
        await api("POST", "/scan-previews", {
          ...base,
          studentId: studentId({ issuer: identity.issuer, uidHex }, identity),
          card: { issuer: identity.issuer, uidHex },
        })
      ).body.code,
    ).toBe("SCAN_ID_REUSED");
    expect(
      (
        await api("POST", "/logs/batch", {
          logs: [
            {
              logId: randomUUID(),
              source: "db",
              code: "DATABASE_EVENT",
              atMs: Date.now(),
              level: "info",
              appVersion: "0.1.0",
            },
          ],
        })
      ).status,
    ).toBe(422);
    expect(
      (await api("POST", "/clients/startup", { version: "0.1.0" })).status,
    ).toBe(200);
    expect((await api("GET", `/operations/${randomUUID()}`)).status).toBe(404);
    const large = await server.app.inject({
      method: "POST",
      url: "/api/v1/scan-previews",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ ignored: "x".repeat(70000) }),
    });
    expect(large.statusCode).toBe(413);
    await expect(
      server.db.records.create({
        id: randomUUID(),
        studentId: "0".repeat(64),
        deviceId: await device(),
        startedAt: new Date(),
        endedAt: null,
        notes: "",
        endReason: null,
        version: 1,
        clientId,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toMatchObject({ name: "SequelizeForeignKeyConstraintError" });
    const health = await server.app.inject({ url: "/health/ready" });
    expect(health.statusCode).toBe(200);
    expect((await server.app.inject({ url: "/health/live" })).statusCode).toBe(
      200,
    );
    const temporary = await login(randomUUID());
    expect((await api("POST", "/auth/logout", {}, temporary)).status).toBe(200);
    expect((await api("GET", "/devices", undefined, temporary)).status).toBe(
      401,
    );
    let rate = 0;
    for (let i = 0; i < 11; i++) {
      const r = await server.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        remoteAddress: "127.0.0.2",
        payload: { username: "wrong", password: "wrong", clientId },
      });
      if (r.statusCode === 429) rate++;
    }
    expect(rate).toBeGreaterThan(0);
  });
  it("S-I-08/14: 业务外端点不存在，数据库及持久结果不含原卡号字段", async () => {
    for (const path of ["/admin", "/students", "/export", "/logs", "/config"])
      expect((await api("GET", path)).status).toBe(404);
    const schema = await server.db.sequelize
      .getQueryInterface()
      .describeTable("students");
    expect(schema.id.type).toContain("64");
    expect(schema).not.toHaveProperty("uidHex");
    expect(schema).not.toHaveProperty("card_hash");
    const operations = JSON.stringify(
      (await server.db.operations.findAll()).map((r) => r.get()),
    );
    expect(operations).not.toContain("uidHex");
    expect(operations).not.toContain("00000001");
    const logs = JSON.stringify(
      (await server.db.logs.findAll()).map((r) => r.get()),
    );
    expect(logs).not.toContain("studentId");
    expect(logs).not.toContain("00000001");
  });
});
