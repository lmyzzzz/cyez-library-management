import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "@record/protocol";
import { studentId } from "@record/protocol/identity";
import { Database } from "../../../apps/server/src/database.js";
import { createApp } from "../../../apps/server/src/app.js";
import { identity, testConfig } from "../../helpers/config.js";

it("S-I-06/07/10/18: 无 seed 的空库迁移、首次登记、API 覆盖缓存与失败后只读缓存", async () => {
  const adminUrl =
    process.env.TEST_DATABASE_URL ??
    "postgres://cyez_test:integration-only@127.0.0.1:55432/cyez_test";
  const admin = new Database(adminUrl);
  const name = "cyez_cache_" + randomUUID().replaceAll("-", "");
  await admin.sequelize.getQueryInterface().createDatabase(name);
  const url = new URL(adminUrl);
  url.pathname = "/" + name;
  const db = new Database(url.toString());
  let server: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const config = testConfig(
      url.toString(),
      await mkdtemp(join(tmpdir(), "cyez-cache-spool-")),
    );
    await db.migrator.up({ to: "001-initial" });
    expect(
      (await db.sequelize.getQueryInterface().describeTable("students"))
        .isEnabled.allowNull,
    ).toBe(false);
    await expect(db.ready()).rejects.toThrow("SCHEMA_NOT_READY");
    await db.migrator.up();
    await db.migrator.up();
    const schema = await db.sequelize
      .getQueryInterface()
      .describeTable("students");
    expect(schema.isEnabled.allowNull).toBe(true);
    expect(schema.seedDigest.allowNull).toBe(true);
    await expect(createApp(config, { database: db })).rejects.toThrow(
      "IDENTITY_CONFIGURATION_MISSING",
    );
    await db.initializeIdentity(identity);
    await db.initializeIdentity(identity);
    const changedIdentity = { ...identity, fixedSaltHex: "11".repeat(16) };
    await expect(db.initializeIdentity(changedIdentity)).rejects.toThrow(
      "IDENTITY_CONFIGURATION_CHANGED",
    );
    await expect(
      createApp({ ...config, identity: changedIdentity }, { database: db }),
    ).rejects.toThrow("IDENTITY_CONFIGURATION_CHANGED");
    let calls = 0;
    let mode = "ok";
    let profile = {
      name: "首次资料",
      className: "旧班级",
      schoolNumber: "OLD",
    };
    server = await createApp(config, {
      database: db,
      provider: {
        async lookup() {
          calls++;
          if (mode === "deny") throw new ApiError("STUDENT_NOT_ALLOWED", 403);
          if (mode === "unavailable") throw Error("provider unavailable");
          if (mode === "invalid") return { name: "缺少必需字段" };
          return profile;
        },
      },
    });
    expect(await db.students.count()).toBe(0);
    const login = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        clientId: randomUUID(),
        username: config.username,
        password: config.password,
      },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().token;
    const api = async (
      method: "GET" | "POST",
      path: string,
      payload?: object,
    ) => {
      const response = await server!.app.inject({
        method,
        url: "/api/v1" + path,
        headers: { authorization: "Bearer " + token },
        payload,
      });
      return { status: response.statusCode, body: response.json() };
    };
    const card = { issuer: identity.issuer, uidHex: "aabbccdd" };
    const id = studentId(card, identity);
    const scan = () =>
      api("POST", "/scan-previews", {
        scanId: randomUUID(),
        studentId: id,
        hashVersion: identity.hashVersion,
        card: { ...card },
        source: "integration",
      });
    const first = await scan();
    expect(first.status).toBe(200);
    expect(first.body.student).toMatchObject({ ...profile, id, version: 1 });
    expect((await db.students.findByPk(id))!.get()).toMatchObject({
      ...profile,
      isEnabled: null,
      seedDigest: null,
    });
    // Legacy flags must not override a successful API lookup or its preview.
    await db.students.update({ isEnabled: false }, { where: { id } });
    const device = await api("POST", "/devices", {
      requestId: randomUUID(),
      code: "CACHE-TEST",
      displayName: "缓存测试设备",
      notes: "",
      isDisabled: false,
      tagIds: [],
    });
    expect(device.status).toBe(200);
    const started = await api("POST", "/usage-records/start", {
      requestId: randomUUID(),
      previewId: first.body.id,
      deviceId: device.body.deviceId,
      notes: "缓存测试",
    });
    expect(started.status).toBe(200);
    profile = { name: "最新资料", className: "", schoolNumber: "" };
    const second = await scan();
    expect(second.status).toBe(200);
    expect(second.body.mode).toBe("end");
    expect(second.body.student).toMatchObject({ ...profile, id, version: 2 });
    expect(calls).toBe(2);
    const cached = (await db.students.findByPk(id))!.get();
    expect(cached).toMatchObject(profile);
    expect(await db.students.count()).toBe(1);
    for (const [failureMode, code] of [
      ["deny", "STUDENT_NOT_ALLOWED"],
      ["invalid", "PROFILE_MISMATCH"],
      ["unavailable", "PROVIDER_UNAVAILABLE"],
    ]) {
      mode = failureMode;
      const rejected = await scan();
      expect(rejected.status).toBeGreaterThanOrEqual(400);
      expect(rejected.body).toEqual({ code });
      expect((await db.students.findByPk(id))!.get()).toEqual(cached);
    }
    const beforeReads = calls;
    const devices = await api("GET", "/devices");
    expect(devices.status).toBe(200);
    expect(devices.body.items[0].active.student).toMatchObject(profile);
    const recordId = started.body.recordId;
    const manual = await api(
      "POST",
      `/usage-records/${recordId}/end-preview`,
      {},
    );
    expect(manual.status).toBe(200);
    expect(
      (
        await api("POST", `/usage-records/${recordId}/end`, {
          requestId: randomUUID(),
          previewId: manual.body.id,
          expectedVersion: manual.body.record.version,
          notes: "",
        })
      ).status,
    ).toBe(200);
    const history = await api("GET", "/usage-records");
    expect(history.status).toBe(200);
    expect(history.body.items[0].student).toMatchObject(profile);
    expect(calls).toBe(beforeReads);
  } finally {
    if (server) await server.app.close();
    else await db.close();
    await admin.sequelize.getQueryInterface().dropDatabase(name);
    await admin.close();
  }
});
