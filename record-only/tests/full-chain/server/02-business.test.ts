import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConnection } from "../harness/connection.js";
import { createStack, sleep } from "../harness/stack.js";
import {
  FullChainClient,
  mustBe,
  reportCode,
  type GatewayResponse,
} from "../harness/api.js";
import { count, studentRow, uid, uniqueCode } from "./support.js";

const connection = await loadConnection();
const stack = await createStack(connection);

let client: FullChainClient;
const state = {
  firstUid: uid("first-scan"),
  firstScanId: randomUUID(),
  firstPreviewId: "" as string,
  firstRecordId: "" as string,
  firstDeviceId: "" as string,
  deviceCode: uniqueCode("FC-DEV"),
  tagId: "" as string,
};

function json<T>(response: GatewayResponse): T {
  return response.json as T;
}

interface PreviewBody {
  id: string;
  mode: "start" | "end";
  student: { id: string; name: string; version: number };
  record: { id: string; version: number } | null;
}
interface DeviceBody {
  deviceId: string;
  version: number;
}
interface RecordBody {
  recordId: string;
  version: number;
}
interface PageBody {
  items: Array<{
    id: string;
    version: number;
    notes: string;
    endedAtMs: number | null;
    endReason: string | null;
    student: { name: string };
    device: { id: string; code: string; displayName: string };
    active?: unknown;
  }>;
  total: number;
}

beforeAll(async () => {
  client = new FullChainClient(connection);
  await client.reauthenticate();
});

describe("全链路：刷卡资料缓存、登记与历史闭环", () => {
  it("空缓存首次刷卡由 provider 建立资料，重复刷卡刷新资料但预览幂等", async () => {
    const student = client.studentIdFor(state.firstUid);
    expect(await studentRow(stack, student)).toBeUndefined();

    const first = await client.scan(state.firstUid, {
      scanId: state.firstScanId,
    });
    mustBe(first, 200, "first scan");
    const preview = json<PreviewBody>(first);
    expect(preview.mode).toBe("start");
    expect(preview.student.id).toBe(student);
    expect(preview.student.name).toBe("集成学生1");
    expect(preview.record).toBeNull();
    expect(first.text).not.toContain(state.firstUid);
    expect(first.text).not.toMatch(/uidHex|card/);
    state.firstPreviewId = preview.id;
    expect(await studentRow(stack, student)).toMatchObject({
      name: "集成学生1",
      version: 1,
    });

    // The same scanId is a retry: cached preview, no extra provider lookup.
    const retry = await client.scan(state.firstUid, {
      scanId: state.firstScanId,
    });
    mustBe(retry, 200, "scan retry");
    expect(json<PreviewBody>(retry).id).toBe(preview.id);
    expect(json<PreviewBody>(retry).student.name).toBe("集成学生1");

    // Any new scan queries the campus provider again and overwrites the cache.
    const refreshed = await client.scan(state.firstUid);
    mustBe(refreshed, 200, "refreshed scan");
    expect(json<PreviewBody>(refreshed).student.name).toBe("集成学生2");
    expect(await studentRow(stack, student)).toMatchObject({
      name: "集成学生2",
      version: 2,
    });
  });

  it("API 明确拒绝、错配 ID、哈希版本与 scanId 复用均不建立缓存", async () => {
    const denied = await client.scan("ffffffff");
    expect(denied.status).toBe(403);
    expect(reportCode(denied)).toBe("STUDENT_NOT_ALLOWED");
    expect(
      await studentRow(stack, client.studentIdFor("ffffffff")),
    ).toBeUndefined();
    expect(await count(stack, "students")).toBeGreaterThan(0);

    const mismatch = await client.scan(state.firstUid, {
      studentIdOverride: "0".repeat(64),
    });
    expect(mismatch.status).toBe(422);
    expect(reportCode(mismatch)).toBe("CARD_ID_MISMATCH");

    const badVersion = await client.scan(state.firstUid, { hashVersion: "v9" });
    expect(badVersion.status).toBe(422);
    expect(reportCode(badVersion)).toBe("HASH_VERSION_UNSUPPORTED");

    const reusedScanId = await client.scan("1a2b3c4d", {
      scanId: state.firstScanId,
    });
    expect(reusedScanId.status).toBe(409);
    expect(reportCode(reusedScanId)).toBe("SCAN_ID_REUSED");
    expect(
      await studentRow(stack, client.studentIdFor("1a2b3c4d")),
    ).toBeUndefined();
  });

  it("provider 故障不覆盖已有缓存、不产生新预览，服务状态与手动结束可用", async () => {
    // First lookup succeeds, later lookups fail: the cached profile must not be
    // used as a fallback for a new scan, and an active record stays endable.
    const cachedUid = "f0f0f0f0";
    const student = client.studentIdFor(cachedUid);
    const first = await client.scan(cachedUid);
    mustBe(first, 200, "cached scan");
    expect(json<PreviewBody>(first).mode).toBe("start");
    const device = json<DeviceBody>(
      mustBe(
        await client.createDevice({ code: uniqueCode("FC-OUTAGE") }),
        200,
        "create device",
      ),
    );
    const started = json<RecordBody>(
      mustBe(
        await client.start(json<PreviewBody>(first).id, device.deviceId),
        200,
        "start record",
      ),
    );
    const before = await studentRow(stack, student);

    const outage = await client.scan(cachedUid);
    expect(outage.status).toBe(503);
    expect(reportCode(outage)).toBe("PROVIDER_UNAVAILABLE");
    expect(await studentRow(stack, student)).toEqual(before);

    const status = mustBe(await client.serviceStatus(), 200, "service status");
    expect(
      json<{ reasonCodes: string[]; allowedActions: string[] }>(status)
        .reasonCodes,
    ).toContain("PROVIDER_UNAVAILABLE");
    expect(json<{ allowedActions: string[] }>(status).allowedActions).toEqual(
      expect.arrayContaining(["read", "end"]),
    );

    const ended = mustBe(
      await client.endWithPreview(started.recordId, {
        notes: "故障中手动结束",
      }),
      200,
      "manual end during provider outage",
    );
    expect(json<RecordBody>(ended).version).toBe(2);

    // A successful later scan restores provider health.
    const recovered = await client.scan(state.firstUid);
    mustBe(recovered, 200, "recovered scan");
    const healthy = mustBe(await client.serviceStatus(), 200, "status");
    expect(json<{ reasonCodes: string[] }>(healthy).reasonCodes).not.toContain(
      "PROVIDER_UNAVAILABLE",
    );
  });

  it("设备与标签 CRUD 有版本控制、占用保护与软删除历史保留", async () => {
    const created = json<DeviceBody>(
      mustBe(
        await client.createDevice({
          code: state.deviceCode,
          displayName: "全链路测试设备",
        }),
        200,
        "create device",
      ),
    );
    state.firstDeviceId = created.deviceId;
    expect(created.version).toBe(1);

    const free = mustBe(
      await client.devices({ state: "free", search: state.deviceCode }),
      200,
      "list free devices",
    );
    expect(json<PageBody>(free).items.map((item) => item.id)).toContain(
      created.deviceId,
    );

    const duplicate = await client.createDevice({ code: state.deviceCode });
    expect(duplicate.status).toBe(409);

    const tag = json<{ tagId: string; version: number }>(
      mustBe(await client.createTag("全链路标签"), 200, "create tag"),
    );
    state.tagId = tag.tagId;
    const edited = json<DeviceBody>(
      mustBe(
        await client.editDevice(created.deviceId, 1, {
          code: state.deviceCode,
          displayName: "全链路设备-更新",
          notes: "设备备注",
          tagIds: [tag.tagId],
        }),
        200,
        "edit device",
      ),
    );
    expect(edited.version).toBe(2);
    const byTag = mustBe(
      await client.devices({ tagId: tag.tagId }),
      200,
      "list by tag",
    );
    expect(json<PageBody>(byTag).items[0]).toMatchObject({
      id: created.deviceId,
      tags: [{ id: tag.tagId }],
    });

    const stale = await client.editDevice(created.deviceId, 1, {
      code: state.deviceCode,
      displayName: "stale",
    });
    expect(stale.status).toBe(409);
    expect(reportCode(stale)).toBe("DEVICE_VERSION_CONFLICT");

    const badTag = await client.editDevice(created.deviceId, 2, {
      code: state.deviceCode,
      displayName: "bad tag",
      tagIds: [randomUUID()],
    });
    expect(badTag.status).toBe(409);
    expect(reportCode(badTag)).toBe("TAG_NOT_FOUND");

    // Deleting a device that currently has an active record is refused.
    const scan = await client.scan(state.firstUid);
    mustBe(scan, 200, "scan before delete");
    const started = json<RecordBody>(
      mustBe(
        await client.start(json<PreviewBody>(scan).id, state.firstDeviceId, {
          notes: "删除保护",
        }),
        200,
        "start on device",
      ),
    );
    const inUse = await client.deleteDevice(state.firstDeviceId, 2);
    expect(inUse.status).toBe(409);
    expect(reportCode(inUse)).toBe("DEVICE_IN_USE");
    mustBe(
      await client.endWithPreview(started.recordId, { notes: "结束" }),
      200,
      "end",
    );

    mustBe(
      await client.deleteDevice(state.firstDeviceId, 2),
      200,
      "soft delete device",
    );
    const after = mustBe(
      await client.devices({ search: state.deviceCode }),
      200,
      "list after delete",
    );
    expect(json<PageBody>(after).items).toEqual([]);
    const history = mustBe(
      await client.records({ state: "ended", deviceId: state.firstDeviceId }),
      200,
      "history after delete",
    );
    expect(json<PageBody>(history).items[0].device.code).toBe(state.deviceCode);

    mustBe(
      await client.request("PATCH", `/tags/${tag.tagId}`, {
        requestId: randomUUID(),
        expectedVersion: 1,
        name: "全链路标签-更新",
      }),
      200,
      "edit tag",
    );
    const staleTag = await client.request("PATCH", `/tags/${tag.tagId}`, {
      requestId: randomUUID(),
      expectedVersion: 1,
      name: "stale",
    });
    expect(staleTag.status).toBe(409);
    expect(reportCode(staleTag)).toBe("TAG_VERSION_CONFLICT");
    mustBe(
      await client.request("DELETE", `/tags/${tag.tagId}`, {
        requestId: randomUUID(),
        expectedVersion: 2,
      }),
      200,
      "delete tag",
    );
  });

  it("登记、备注修改、结束与只读历史符合业务规则", async () => {
    const device = json<DeviceBody>(
      mustBe(
        await client.createDevice({ code: uniqueCode("FC-FLOW") }),
        200,
        "create device",
      ),
    );
    const scanUid = uid("manual-flow");
    const scan = await client.scan(scanUid);
    mustBe(scan, 200, "scan");
    const preview = json<PreviewBody>(scan);
    const started = json<RecordBody>(
      mustBe(
        await client.start(preview.id, device.deviceId, {
          notes: "初始备注",
        }),
        200,
        "start",
      ),
    );
    expect(started.version).toBe(1);

    const active = mustBe(
      await client.devices({ state: "active" }),
      200,
      "list active",
    );
    expect(
      json<PageBody>(active).items.find((item) => item.id === device.deviceId)
        ?.active,
    ).toMatchObject({
      id: started.recordId,
      notes: "初始备注",
    });

    const staleNotes = await client.editNotes(started.recordId, 99, "过期版本");
    expect(staleNotes.status).toBe(409);
    expect(reportCode(staleNotes)).toBe("RECORD_VERSION_CONFLICT");

    mustBe(
      await client.editNotes(started.recordId, 1, "修改后备注"),
      200,
      "edit notes",
    );

    const endPreview = mustBe(
      await client.endPreview(started.recordId),
      200,
      "end preview",
    );
    const previewBody = json<{
      id: string;
      record: { version: number; notes: string };
    }>(endPreview);
    expect(previewBody.record.version).toBe(2);
    expect(previewBody.record.notes).toBe("修改后备注");

    mustBe(
      await client.end(started.recordId, previewBody.id, 2, {
        notes: "结束备注",
      }),
      200,
      "end",
    );

    const history = mustBe(
      await client.records({ state: "ended", deviceId: device.deviceId }),
      200,
      "history",
    );
    expect(json<PageBody>(history).items[0]).toMatchObject({
      id: started.recordId,
      notes: "结束备注",
      endReason: "manual",
      version: 3,
    });
    expect(json<PageBody>(history).items[0].endedAtMs).toBeGreaterThan(0);

    const readOnly = await client.editNotes(started.recordId, 3, "结束后修改");
    expect(
      readOnly.status,
      `editNotes after end: ${readOnly.status} ${readOnly.text}`,
    ).toBe(409);
    expect(reportCode(readOnly)).toBe("HISTORY_READ_ONLY");
    const secondEnd = await client.endPreview(started.recordId);
    expect(secondEnd.status).toBe(409);
    expect(reportCode(secondEnd)).toBe("HISTORY_READ_ONLY");
    for (const method of ["DELETE", "GET"] as const) {
      const missing = await client.request(
        method,
        `/usage-records/${started.recordId}`,
      );
      expect(missing.status).toBe(404);
    }
  });

  it("两个客户端并发登记同一学生/设备只产生一条活动记录", async () => {
    const clientB = new FullChainClient(connection);
    mustBe(await clientB.login(), 200, "second client login");
    const deviceA = json<DeviceBody>(
      mustBe(
        await client.createDevice({ code: uniqueCode("FC-RACE-A") }),
        200,
        "device A",
      ),
    );
    const deviceB = json<DeviceBody>(
      mustBe(
        await clientB.createDevice({ code: uniqueCode("FC-RACE-B") }),
        200,
        "device B",
      ),
    );

    // Same student, two different devices, two clients, concurrent start.
    const studentUid = uid("race-student");
    const previewA = json<PreviewBody>(
      mustBe(await client.scan(studentUid), 200, "scan A"),
    );
    const previewB = json<PreviewBody>(
      mustBe(await clientB.scan(studentUid), 200, "scan B"),
    );
    const [startA, startB] = await Promise.all([
      client.start(previewA.id, deviceA.deviceId),
      clientB.start(previewB.id, deviceB.deviceId),
    ]);
    const results = [startA, startB];
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(results.filter((result) => result.status === 409)).toHaveLength(1);
    const activeForStudent = (await stack.snapshot()).records.filter(
      (row) =>
        row.studentId === client.studentIdFor(studentUid) &&
        row.endedAt === null,
    ).length;
    expect(activeForStudent).toBe(1);
    const winner = json<RecordBody>(results.find((r) => r.status === 200)!);
    const winnerClient = startA.status === 200 ? client : clientB;
    mustBe(
      await winnerClient.endWithPreview(winner.recordId, { notes: "竞争结束" }),
      200,
      "end winner",
    );

    // Same device, two students: only one active record may exist.
    const deviceC = json<DeviceBody>(
      mustBe(
        await client.createDevice({ code: uniqueCode("FC-RACE-C") }),
        200,
        "device C",
      ),
    );
    const student1 = uid("race-student-1");
    const student2 = uid("race-student-2");
    const preview1 = json<PreviewBody>(
      mustBe(await client.scan(student1), 200, "scan 1"),
    );
    const preview2 = json<PreviewBody>(
      mustBe(await clientB.scan(student2), 200, "scan 2"),
    );
    const [start1, start2] = await Promise.all([
      client.start(preview1.id, deviceC.deviceId),
      clientB.start(preview2.id, deviceC.deviceId),
    ]);
    expect(
      [start1, start2].filter((result) => result.status === 200),
    ).toHaveLength(1);
    expect(
      [start1, start2].filter((result) => result.status === 409),
    ).toHaveLength(1);
    const activeForDevice = (await stack.snapshot()).records.filter(
      (row) => row.deviceId === deviceC.deviceId && row.endedAt === null,
    ).length;
    expect(activeForDevice).toBe(1);
    const deviceWinner = json<RecordBody>(
      [start1, start2].find((result) => result.status === 200)!,
    );
    const winnerForDevice = start1.status === 200 ? client : clientB;
    mustBe(
      await winnerForDevice.endWithPreview(deviceWinner.recordId, {
        notes: "设备竞争结束",
      }),
      200,
      "end device race winner",
    );
  });

  it("批量结束固定集合、混入历史的预览拒绝、重复确认幂等", async () => {
    const deviceIds: string[] = [];
    const recordIds: string[] = [];
    for (const label of ["batch-a", "batch-b"]) {
      const device = json<DeviceBody>(
        mustBe(
          await client.createDevice({ code: uniqueCode(`FC-${label}`) }),
          200,
          "create batch device",
        ),
      );
      deviceIds.push(device.deviceId);
      const scan = json<PreviewBody>(
        mustBe(await client.scan(uid(label)), 200, "batch scan"),
      );
      const started = json<RecordBody>(
        mustBe(
          await client.start(scan.id, device.deviceId, {
            notes: `${label} 原备注`,
          }),
          200,
          "batch start",
        ),
      );
      recordIds.push(started.recordId);
    }

    const preview = mustBe(
      await client.batchPreview({ scope: "selected", recordIds }),
      200,
      "batch preview",
    );
    const body = json<{
      units: Array<{ id: string; records: Array<{ id: string }> }>;
      total: number;
      scope: string;
    }>(preview);
    expect(body.scope).toBe("selected");
    expect(body.total).toBe(2);
    expect(body.units).toHaveLength(1);
    expect(body.units[0].records.map((record) => record.id).sort()).toEqual(
      [...recordIds].sort(),
    );

    const requestId = randomUUID();
    const confirmed = mustBe(
      await client.batchConfirm(body.units[0].id, {
        requestId,
        notes: "学期结束",
      }),
      200,
      "batch confirm",
    );
    expect(json<{ count: number }>(confirmed).count).toBe(2);
    for (const recordId of recordIds) {
      const row = (await stack.snapshot()).records.find(
        (row) => row.id === recordId,
      )!;
      expect(row.endedAt).not.toBeNull();
      expect(row.notes).toContain("原备注");
      expect(row.notes).toContain("批量结束备注：学期结束");
      expect(row.endReason).toBe("batch");
    }

    // Replaying the same requestId returns the persisted result, not a new write.
    const replay = mustBe(
      await client.batchConfirm(body.units[0].id, {
        requestId,
        notes: "学期结束",
      }),
      200,
      "batch replay",
    );
    expect(json(replay)).toEqual(json(confirmed));

    const active = json<DeviceBody>(
      mustBe(
        await client.createDevice({ code: uniqueCode("FC-BATCH-ROLLBACK") }),
        200,
        "rollback device",
      ),
    );
    const scan = json<PreviewBody>(
      mustBe(await client.scan(uid("batch-rollback")), 200, "rollback scan"),
    );
    const activeRecord = json<RecordBody>(
      mustBe(
        await client.start(scan.id, active.deviceId),
        200,
        "rollback start",
      ),
    );
    const rollback = await client.batchPreview({
      scope: "selected",
      recordIds: [activeRecord.recordId, recordIds[0]],
    });
    expect(rollback.status).toBe(409);
    expect(reportCode(rollback)).toBe("RECORD_VERSION_CONFLICT");
    const stillActive = (await stack.snapshot()).records.filter(
      (row) => row.id === activeRecord.recordId && row.endedAt === null,
    ).length;
    expect(stillActive).toBe(1);
    mustBe(
      await client.endWithPreview(activeRecord.recordId),
      200,
      "rollback cleanup",
    );
    const emptySelection = await client.batchPreview({
      scope: "selected",
      recordIds: [],
    });
    expect(emptySelection.status).toBe(422);
    expect(reportCode(emptySelection)).toBe("INPUT_INVALID");
  });

  it("业务外端点不存在、鉴权与输入边界明确", async () => {
    for (const path of [
      "/students",
      "/administrators",
      "/seed",
      "/logs",
      "/admin/config",
    ]) {
      const response = await client.request("GET", path);
      expect([404, 401]).toContain(response.status);
      if (response.status === 401)
        expect(reportCode(response)).toBe("AUTH_REQUIRED");
      else expect(response.status).toBe(404);
    }
    const unauthenticated = new FullChainClient(connection);
    expect(reportCode(await unauthenticated.request("GET", "/devices"))).toBe(
      "AUTH_REQUIRED",
    );
    expect(
      reportCode(
        await client.request("GET", "/devices", undefined, {
          token: "f".repeat(64),
        }),
      ),
    ).toBe("AUTH_REQUIRED");
    const malformed = await client.request(
      "POST",
      "/scan-previews",
      undefined,
      { rawBody: '{"scanId":' },
    );
    expect(malformed.status).toBe(422);
    expect(reportCode(malformed)).toBe("INPUT_INVALID");

    const badBody = await client.request("POST", "/scan-previews", {
      scanId: randomUUID(),
    });
    expect(badBody.status).toBe(422);
    expect(reportCode(badBody)).toBe("INPUT_INVALID");
  });

  it("客户端日志批量上传按稳定 ID 去重，且不接受服务端来源", async () => {
    const logId = randomUUID();
    const log = {
      logId,
      source: "main",
      level: "info",
      atMs: Date.now(),
      appVersion: "0.1.0",
      code: "APP_STARTED",
    };
    mustBe(await client.logsBatch([log]), 200, "log batch");
    const replay = mustBe(await client.logsBatch([log]), 200, "log replay");
    expect(json<{ acked: string[] }>(replay).acked).toEqual([logId]);
    const duplicate = (await stack.snapshot()).logs.filter(
      (row) => row.logId === logId && row.origin === client.clientId,
    ).length;
    expect(duplicate).toBe(1);

    const serverSource = await client.logsBatch([
      { ...log, logId: randomUUID(), source: "api" },
    ]);
    expect(serverSource.status).toBe(422);
    expect(reportCode(serverSource)).toBe("LOG_SOURCE_INVALID");
    expect((await client.request("GET", "/logs/batch")).status).toBe(404);
  });

  it("原始卡号只在请求内流转，不落入数据库、spool 或服务端日志", async () => {
    const rawUid = "00abcdef";
    const scan = await client.scan(rawUid);
    mustBe(scan, 200, "raw card scan");
    expect(scan.text).not.toContain(rawUid);
    const student = client.studentIdFor(rawUid);
    expect(await studentRow(stack, student)).toBeTruthy();

    await sleep(1500);
    const snapshot = await stack.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain(rawUid);

    for (const [service, directory] of [
      ["api", "/data/api-spool"],
      ["gateway", "/var/log/cyez"],
      ["db", "/var/log/cyez"],
    ] as const) {
      const text = await stack.readDirectory(service, directory);
      expect(text, `${service}:${directory}`).not.toContain(rawUid);
    }
  });
});
