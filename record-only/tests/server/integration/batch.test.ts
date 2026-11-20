import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { adjacencyGradeOf, GRADE_RANK, resolveSeat } from "@record/domain";
import type { AdjacencyGrade } from "@record/protocol";
import { studentId } from "@record/protocol/identity";
import { Database } from "../../../apps/server/src/database.js";
import { createApp } from "../../../apps/server/src/app.js";
import { testConfig, identity } from "../../helpers/config.js";
import type { Config } from "../../../apps/server/src/config.js";
import type { CampusProvider } from "../../../apps/server/src/provider.js";

const defaultUrl = () =>
  process.env.TEST_DATABASE_URL ??
  "postgres://cyez_test:integration-only@127.0.0.1:55432/cyez_test";

/** 真实 PG 探活；库不可用时整组用例优雅跳过，而不是崩在 beforeAll。 */
async function canConnect(): Promise<boolean> {
  const client = new Client({
    connectionString: defaultUrl(),
    connectionTimeoutMillis: 1500,
  });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}
const available = await canConnect();

const layout = {
  // 区域一 [section1Start, section1Start + section1End − 1)：默认 1..7，两张四人桌。
  section1Start: 1,
  section1End: 8,
  // 区域二从 31 起编号：31 33 同排相邻，31 32 隔空档正对。
  section2Start: 31,
  section3Start: 41,
  allowCrossArea: true,
  batchWindowSec: 10,
  batchStudentLimit: 8,
};
/** 区域二起点改成 51 之后的同一套布局（用例里验证起点可配置）。 */
const layout51 = { ...layout, section2Start: 51 };

describe.skipIf(!available)("真实 PostgreSQL：相邻试验组批次与布局设置", () => {
  let server: Awaited<ReturnType<typeof createApp>>,
    admin: Database,
    config: Config,
    token: string,
    token2: string;
  const clientId = randomUUID(),
    client2 = randomUUID();
  let now = Date.parse("2026-11-19T09:00:00+08:00");
  let serial = 100;
  const probe = { freeBytes: 100000, writable: true, oldestAgeMs: 0 };
  const provider: CampusProvider = {
    async lookup(card) {
      expect(card.uidHex).toMatch(/^(?:[0-9a-f]{2}){4}$/);
      return {
        name: "试验组学生" + card.uidHex.slice(-2),
        className: "试验一班",
        schoolNumber: "EXP" + card.uidHex.slice(-2),
      };
    },
  };
  const databaseName = "cyez_batch_" + randomUUID().replaceAll("-", "");
  // 每个用例自己的本机批次：先把上一个批次关掉，避免跨用例并入。
  let currentBatch: string | undefined;

  beforeAll(async () => {
    admin = new Database(defaultUrl());
    await admin.sequelize.getQueryInterface().createDatabase(databaseName);
    const url = new URL(defaultUrl());
    url.pathname = "/" + databaseName;
    config = testConfig(
      url.toString(),
      await mkdtemp(join(tmpdir(), "cyez-batch-spool-")),
    );
    const db = new Database(config.databaseUrl);
    await db.migrator.up();
    await db.migrator.up();
    const schema = await db.sequelize
      .getQueryInterface()
      .describeTable("students");
    expect(schema.experimentGroup.allowNull).toBe(false);
    await db.initializeIdentity(identity);
    server = await createApp(config, {
      database: db,
      provider,
      now: () => now,
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
  async function login(id: string) {
    const r = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: config.username,
        password: config.password,
        clientId: id,
      },
    });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  }
  async function api(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
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
  function card() {
    serial += 1;
    const uidHex = serial.toString(16).padStart(8, "0");
    return {
      scanId: randomUUID(),
      studentId: studentId({ issuer: identity.issuer, uidHex }, identity),
      hashVersion: identity.hashVersion,
      card: { issuer: identity.issuer, uidHex },
      source: "integration" as const,
    };
  }
  async function scan(payload = card(), auth = token) {
    return api("POST", "/scan-previews", payload, auth);
  }
  async function device(code: string) {
    const r = await api("POST", "/devices", {
      requestId: randomUUID(),
      code,
      displayName: "电脑 " + code,
      notes: "",
      isDisabled: false,
      tagIds: [],
    });
    expect(r.status).toBe(200);
    return r.body.deviceId as string;
  }
  async function markExperiment(studentIdentifier: string, enabled = true) {
    const r = await api("PUT", `/students/${studentIdentifier}/experiment`, {
      requestId: randomUUID(),
      enabled,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      studentId: studentIdentifier,
      experimentGroup: enabled,
    });
  }
  /** 关闭当前收集中的批次（不分配），让下一位刷卡开启新批次。 */
  async function resetBatch() {
    if (!currentBatch) return;
    const id = currentBatch;
    currentBatch = undefined;
    const intent = server.service.previews.entries.get(id);
    if (intent && intent.state === "collecting") intent.state = "closed";
  }
  /** 刷出学生缓存、标记为试验组成员，然后刷回批次。 */
  async function enterBatch() {
    await resetBatch();
    const payload = card();
    const first = await scan(payload);
    expect(first.status).toBe(200);
    await markExperiment(payload.studentId);
    const again = await scan({ ...payload, scanId: randomUUID() });
    expect(again.status).toBe(200);
    expect(again.body.mode).toBe("batch");
    currentBatch = again.body.batch.id as string;
    return { payload, batch: again.body };
  }
  /** 加入批次的新成员：先建立缓存与标记，再 join。
   * 第一次刷卡时学生还没被标记，所以不会并入批次。 */
  async function member(batchId: string) {
    const payload = card();
    const first = await scan(payload);
    expect(first.status).toBe(200);
    await markExperiment(payload.studentId);
    const joined = await api("POST", `/scan-previews/${batchId}/join`, {
      ...payload,
      scanId: randomUUID(),
    });
    return { payload, joined };
  }
  /** 用户口径：只有 excellent（肩并肩）/ good（相邻桌角对角）算“真相邻”，
   * degraded（面对面 / 斜对角 / 绕到对面）属于“勉强”，不能作为可用结果。 */
  function expectStronglyAdjacent(codes: string[]) {
    for (let i = 0; i < codes.length; i += 1)
      for (let j = i + 1; j < codes.length; j += 1) {
        const relation = adjacencyGradeOf(codes[i]!, codes[j]!, layout);
        expect({ pair: [codes[i], codes[j]], relation }).toEqual({
          pair: [codes[i], codes[j]],
          relation: expect.not.stringMatching(/^(degraded|none)$/),
        });
        expect(GRADE_RANK[relation as AdjacencyGrade]).toBeLessThanOrEqual(
          GRADE_RANK.good,
        );
      }
  }
  async function freeDevices() {
    await server.db.records.update(
      { endedAt: new Date(now) },
      { where: { endedAt: null } },
    );
    await server.db.devices.update(
      { deletedAt: new Date(now) },
      { where: { deletedAt: null } },
    );
  }

  it("试验组学生刷卡返回批次，普通学生刷卡仍是 start", async () => {
    const normal = await scan();
    expect(normal.status).toBe(200);
    expect(normal.body.mode).toBe("start");
    expect(normal.body.batch ?? null).toBeNull();
    const { batch } = await enterBatch();
    expect(batch.batch.state).toBe("collecting");
    expect(batch.batch.students).toHaveLength(1);
    expect(batch.batch.closesAtMs - batch.batch.atMs).toBe(10000);
  });

  it("连续加入 3 人留在同一批次，重复刷卡立即分配", async () => {
    // 区域一（第 1 段 1..7）：1 2 肩并肩、3 4 肩并肩、2 3 同桌前两角、
    // 4 5 跨桌角对角 → 3 人可达成 good；区域二 31/33 被 32 隔开，只能 degraded。
    for (const code of ["1-21-41", "2-21-42", "3-21-43", "4-21-44", "5-21-45"])
      await device(code);
    const first = await enterBatch();
    const batchId = first.batch.batch.id as string;
    for (let index = 0; index < 2; index += 1) {
      const { joined } = await member(batchId);
      expect(joined.status).toBe(200);
      expect(joined.body.id).toBe(batchId);
      expect(joined.body.mode).toBe("batch");
      expect(joined.body.batch.state).toBe("collecting");
    }
    const list = await api("GET", `/batches/${batchId}`);
    expect(list.status).toBe(200);
    expect(list.body.students).toHaveLength(3);
    expect(list.body.state).toBe("collecting");
    // 重复刷卡：批次结束信号，立即分配。
    const duplicate = await api("POST", `/scan-previews/${batchId}/join`, {
      ...first.payload,
      scanId: randomUUID(),
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.mode).toBe("end");
    expect(duplicate.body.batch.state).toBe("assigned");
    expect(duplicate.body.assignment.batchId).toBe(batchId);
    expect(duplicate.body.batch.duplicates).toHaveLength(1);
    // 只认 excellent/good：degraded（面对面/斜对角）属于“勉强”，不算可用。
    expect(
      GRADE_RANK[duplicate.body.assignment.grade as AdjacencyGrade],
    ).toBeLessThanOrEqual(GRADE_RANK.good);
    expect(duplicate.body.assignment.assigned).toHaveLength(3);
    const codes = duplicate.body.assignment.assigned.map(
      (a: { code: string }) => a.code,
    );
    expect(new Set(codes).size).toBe(3);
    expectStronglyAdjacent(codes);
    const studentIds = duplicate.body.assignment.assigned.map(
      (a: { studentId: string }) => a.studentId,
    );
    const rows = await server.db.records.findAll({
      where: { studentId: studentIds, endedAt: null },
    });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.get().deviceId)).size).toBe(3);
    for (const row of rows) {
      expect(row.get().startedAt.getTime()).toBe(
        duplicate.body.assignment.atMs,
      );
      expect(row.get().notes).toBe("");
      expect(row.get().endReason).toBeNull();
      expect(row.get().version).toBe(1);
    }
    // 分配后每个学生都有 activity record，再查设备能看到占用。
    const devices = await api("GET", "/devices?state=active&pageSize=100");
    expect(devices.body.total).toBe(3);
    currentBatch = undefined;
  });

  it("非试验组学生 join 返回 EXPERIMENT_GROUP_DISABLED，卡号不符返回 CARD_ID_MISMATCH", async () => {
    const { batch } = await enterBatch();
    const batchId = batch.batch.id as string;
    const other = card();
    const normal = await scan(other);
    expect(normal.body.mode).toBe("start");
    const denied = await api("POST", `/scan-previews/${batchId}/join`, {
      ...other,
      scanId: randomUUID(),
    });
    expect(denied.status).toBe(422);
    expect(denied.body.code).toBe("EXPERIMENT_GROUP_DISABLED");
    const mismatch = await api("POST", `/scan-previews/${batchId}/join`, {
      ...card(),
      studentId: other.studentId,
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.code).toBe("CARD_ID_MISMATCH");
    const missing = await api(
      "POST",
      `/scan-previews/${randomUUID()}/join`,
      card(),
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("BATCH_NOT_FOUND");
  });

  it("批次不属于当前会话时返回 PREVIEW_FORBIDDEN", async () => {
    const { batch } = await enterBatch();
    const foreign = await api(
      "GET",
      `/batches/${batch.batch.id}`,
      undefined,
      token2,
    );
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe("PREVIEW_FORBIDDEN");
  });

  it("教师 close/confirm 互斥且幂等", async () => {
    for (const code of ["3-24-46", "3-25-47", "3-26-48"]) await device(code);
    const { batch } = await enterBatch();
    const batchId = batch.batch.id as string;
    const requestId = randomUUID();
    const closed = await api("POST", `/scan-previews/${batchId}/close`, {
      requestId,
    });
    expect(closed.status).toBe(200);
    expect(closed.body.batchId).toBe(batchId);
    // 同 requestId 重试：返回已提交的持久结果。
    const retried = await api("POST", `/scan-previews/${batchId}/close`, {
      requestId,
    });
    expect(retried.status).toBe(200);
    expect(retried.body).toEqual(closed.body);
    // 换 requestId 走 close：同一预览只能分配一次。
    const again = await api("POST", `/scan-previews/${batchId}/close`, {
      requestId: randomUUID(),
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("PREVIEW_ALREADY_USED");
    // confirm 换了 requestId：同样受 intentId 唯一约束保护。
    const confirmOther = await api("POST", `/batches/${batchId}/confirm`, {
      requestId: randomUUID(),
    });
    expect(confirmOther.status).toBe(409);
    expect(confirmOther.body.code).toBe("PREVIEW_ALREADY_USED");
    // 新建批次后用 confirm 分配，验证 confirm 路由本身可用且结果持久。
    const fresh = await enterBatch();
    const confirmId = randomUUID();
    const confirmed = await api(
      "POST",
      `/batches/${fresh.batch.batch.id}/confirm`,
      { requestId: confirmId },
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.batchId).toBe(fresh.batch.batch.id);
    const confirmRetry = await api(
      "POST",
      `/batches/${fresh.batch.batch.id}/confirm`,
      { requestId: confirmId },
    );
    expect(confirmRetry.status).toBe(200);
    expect(confirmRetry.body).toEqual(confirmed.body);
    const status = await api("GET", `/batches/${fresh.batch.batch.id}`);
    expect(status.body.state).toBe("assigned");
  });

  it("设备不足时返回 DEVICE_CAPACITY_INSUFFICIENT 且不写任何 usage_record", async () => {
    await freeDevices();
    await device("5-30-60");
    const first = await enterBatch();
    const batchId = first.batch.batch.id as string;
    const { joined } = await member(batchId);
    expect(joined.status).toBe(200);
    const before = await server.db.records.count();
    const closed = await api("POST", `/scan-previews/${batchId}/close`, {
      requestId: randomUUID(),
    });
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe("DEVICE_CAPACITY_INSUFFICIENT");
    expect(await server.db.records.count()).toBe(before);
    const state = await api("GET", `/batches/${batchId}`);
    expect(state.body.state).toBe("collecting");
  });

  it("纯名字设备：座位号从名字里抽取，4 台排成 3 4 5 6 得到 good", async () => {
    await freeDevices();
    const names = [
      "图书馆A区第3排 3 号机",
      "图书馆A区第3排 4 号机",
      "图书馆A区第5排 5 号机",
      "图书馆A区第5排 6 号机",
    ];
    for (const name of names) await device(name);
    const first = await enterBatch();
    const batchId = first.batch.batch.id as string;
    for (let index = 0; index < 3; index += 1) {
      const { joined } = await member(batchId);
      expect(joined.status).toBe(200);
    }
    const assigned = await api("POST", `/batches/${batchId}/confirm`, {
      requestId: randomUUID(),
    });
    expect(assigned.status).toBe(200);
    // 3 4 5 6：3-4 与 5-6 肩并肩，4↔5 跨桌角对角 → 整批 good。
    expect(
      GRADE_RANK[assigned.body.grade as AdjacencyGrade],
    ).toBeLessThanOrEqual(GRADE_RANK.good);
    expect(assigned.body.assigned).toHaveLength(4);
    const codes = assigned.body.assigned.map((a: { code: string }) => a.code);
    for (const code of codes) expect(names).toContain(code);
    expect(new Set(codes).size).toBe(4);
    // 名字解析成功时不应报“解析不出座位号”。
    expect(assigned.body.unresolvedDevices ?? []).toEqual([]);
  });

  it("设备名里没有座位号时仍完成分配，并把设备列入 unresolvedDevices", async () => {
    await freeDevices();
    // specification.md：整批都无几何可算时按 clustered/scattered 展示并**仍完成分配**，
    // 不能因为设备名不合规就让整个批次功能不可用。
    const names = ["未命名机位", "未命名机位两个", "未命名机位三"];
    for (const name of names) await device(name);
    // 前提复核：这些名字确实解析不出座位号。
    const effective = server.service.layout();
    for (const name of names) expect(resolveSeat(name, effective)).toBeNull();
    const first = await enterBatch();
    const batchId = first.batch.batch.id as string;
    const { joined } = await member(batchId);
    expect(joined.status).toBe(200);
    const before = await server.db.records.count();
    const closed = await api("POST", `/scan-previews/${batchId}/close`, {
      requestId: randomUUID(),
    });
    expect(closed.status).toBe(200);
    expect(closed.body.assigned).toHaveLength(2);
    expect(await server.db.records.count()).toBe(before + 2);
    // 解析失败的设备通过诊断字段回传，教师端据此提示“这些名字里找不到座位号”。
    expect(closed.body.unresolvedDevices?.length).toBeGreaterThan(0);
  });

  it("单批人数上限返回 BATCH_FULL", async () => {
    await freeDevices();
    const layoutNow = await api("GET", "/layout");
    const updated = await api("PUT", "/layout", {
      requestId: randomUUID(),
      expectedVersion: layoutNow.body.version,
      ...layout,
      batchStudentLimit: 2,
    });
    expect(updated.status).toBe(200);
    const first = await enterBatch();
    const batchId = first.batch.batch.id as string;
    const { joined } = await member(batchId);
    expect(joined.status).toBe(200);
    expect(joined.body.batch.students).toHaveLength(2);
    const overflow = card();
    await scan(overflow);
    await markExperiment(overflow.studentId);
    const full = await api("POST", `/scan-previews/${batchId}/join`, {
      ...overflow,
      scanId: randomUUID(),
    });
    expect(full.status).toBe(409);
    expect(full.body.code).toBe("BATCH_FULL");
  });

  it("布局设置版本冲突返回 LAYOUT_VERSION_CONFLICT", async () => {
    const current = await api("GET", "/layout");
    expect(current.status).toBe(200);
    expect(current.body.settings.batchStudentLimit).toBe(2);
    const updated = await api("PUT", "/layout", {
      requestId: randomUUID(),
      expectedVersion: current.body.version,
      ...layout,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.version).toBe(current.body.version + 1);
    expect(updated.body.settings.batchStudentLimit).toBe(8);
    const conflict = await api("PUT", "/layout", {
      requestId: randomUUID(),
      expectedVersion: current.body.version,
      ...layout,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("LAYOUT_VERSION_CONFLICT");
  });

  it("区域三起点必须是完整桌子的第一个角：42 拒绝、45 接受", async () => {
    const current = await api("GET", "/layout");
    expect(current.status).toBe(200);
    // (x - 41) % 4 === 0：41、45、49…；42 是半张桌子，schema 直接 422。
    const invalid = await api("PUT", "/layout", {
      requestId: randomUUID(),
      expectedVersion: current.body.version,
      ...layout,
      section3Start: 42,
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.code).toBe("INPUT_INVALID");
    // 被拒绝的请求不消费 requestId、不推进版本。
    const stillCurrent = await api("GET", "/layout");
    expect(stillCurrent.body.version).toBe(current.body.version);
    const valid = await api("PUT", "/layout", {
      requestId: randomUUID(),
      expectedVersion: current.body.version,
      ...layout,
      section3Start: 45,
    });
    expect(valid.status).toBe(200);
    expect(valid.body.settings.section3Start).toBe(45);
    expect(valid.body.version).toBe(current.body.version + 1);
    // 复原默认分界点，避免影响后续用例。
    const restored = await api("PUT", "/layout", {
      requestId: randomUUID(),
      expectedVersion: valid.body.version,
      ...layout,
    });
    expect(restored.status).toBe(200);
    expect(restored.body.settings.section3Start).toBe(41);
  });

  it("区域二起点可改：section2Start 改成 51 后 51/53 同排相邻、51/52 正对", async () => {
    const current = await api("GET", "/layout");
    expect(current.status).toBe(200);
    expect(current.body.settings.section2Start).toBe(31);
    // 默认 31 时：31↔33 同排相邻（excellent），31↔32 隔空档正对（degraded）。
    expect(adjacencyGradeOf("0-31-0", "0-33-0", layout)).toBe("excellent");
    expect(adjacencyGradeOf("0-31-0", "0-32-0", layout)).toBe("degraded");
    // 教师把第二排起点改成 51：同一套几何整体右移。
    const updated = await api("PUT", "/layout", {
      requestId: randomUUID(),
      expectedVersion: current.body.version,
      ...layout,
      section2Start: 51,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.settings.section2Start).toBe(51);
    // 服务端已把内存缓存换成新设置：设备编号按新起点解析。
    expect(server.service.layout().section2Start).toBe(51);
    expect(adjacencyGradeOf("0-51-0", "0-53-0", layout51)).toBe("excellent");
    expect(adjacencyGradeOf("0-51-0", "0-52-0", layout51)).toBe("degraded");
    // 新的起点边界之外（< 51）不再属于区域二。
    expect(adjacencyGradeOf("0-49-0", "0-51-0", layout51)).toBe("none");
    // 复原，避免影响后续用例。
    const restored = await api("PUT", "/layout", {
      requestId: randomUUID(),
      expectedVersion: updated.body.version,
      ...layout,
    });
    expect(restored.status).toBe(200);
    expect(restored.body.settings.section2Start).toBe(31);
  });

  it("试验组列表分页与搜索，资料刷新不覆盖 experimentGroup", async () => {
    const listed = await api("GET", "/students/experiment?pageSize=100");
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBeGreaterThan(0);
    for (const item of listed.body.items)
      expect(item.experimentGroup).toBe(true);
    const searched = await api("GET", "/students/experiment?search=试验一班");
    expect(searched.body.items.length).toBe(searched.body.total);
    expect(searched.body.total).toBeGreaterThan(0);
    const target = searched.body.items[0] as { id: string };
    const before = await server.db.students.findByPk(target.id);
    expect(before!.get().experimentGroup).toBe(true);
    // 缓存刷新（普通刷卡）不得把标记冲掉。
    const payload = card();
    const first = await scan(payload);
    expect(first.status).toBe(200);
    await server.db.students.update(
      { experimentGroup: true },
      { where: { id: payload.studentId } },
    );
    const beforeVersion = (await server.db.students.findByPk(
      payload.studentId,
    ))!.get().version;
    await scan({ ...payload, scanId: randomUUID() });
    const row = await server.db.students.findByPk(payload.studentId);
    expect(row!.get().experimentGroup).toBe(true);
    expect(row!.get().version).toBeGreaterThan(beforeVersion);
    // 取消标记与未知学生。
    const disabled = await api(
      "PUT",
      `/students/${payload.studentId}/experiment`,
      { requestId: randomUUID(), enabled: false },
    );
    expect(disabled.body).toEqual({
      studentId: payload.studentId,
      experimentGroup: false,
    });
    const missing = await api("PUT", `/students/${"0".repeat(64)}/experiment`, {
      requestId: randomUUID(),
      enabled: true,
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("NOT_FOUND");
  });

  it("过期批次在 GET/join 时惰性关闭", async () => {
    const { batch } = await enterBatch();
    now = batch.batch.closesAtMs + 1;
    try {
      const state = await api("GET", `/batches/${batch.batch.id}`);
      expect(state.status).toBe(200);
      expect(state.body.state).toBe("closed");
      const late = await api(
        "POST",
        `/scan-previews/${batch.batch.id}/join`,
        card(),
      );
      expect(late.status).toBe(410);
      expect(late.body.code).toBe("BATCH_CLOSED");
      const closed = await api(
        "POST",
        `/scan-previews/${batch.batch.id}/close`,
        { requestId: randomUUID() },
      );
      expect([200, 409, 410]).toContain(closed.status);
    } finally {
      now = batch.batch.closesAtMs - 10000;
    }
  });

  it("批次分配后每人可分别刷卡结束", async () => {
    /*
     * 用户要求：一起进来的这批人必须能各自离开。
     * 分配后每人的 usage_record 是独立一条，所以单人刷卡结束只影响他自己。
     */
    for (const code of ["7-21-41", "7-22-42"]) await device(code);
    const { payload: first, batch } = await enterBatch();
    const batchId = batch.batch.id as string;
    const { payload: second, joined } = await member(batchId);
    expect(joined.status).toBe(200);
    const close = await api("POST", `/scan-previews/${batchId}/close`, {
      requestId: randomUUID(),
    });
    expect(close.status).toBe(200);
    const assigned = close.body.assigned as {
      studentId: string;
      deviceId: string;
    }[];
    expect(assigned).toHaveLength(2);
    currentBatch = undefined;

    // 第一个人单独刷卡：应得到他自己的结束预览，且只结束这一条。
    const endFirst = await scan({ ...first, scanId: randomUUID() });
    expect(endFirst.status).toBe(200);
    expect(endFirst.body.mode).toBe("end");
    // 分配顺序由座位号决定，不保证等于刷卡顺序，按集合判断。
    expect(assigned.map((seat) => seat.studentId)).toContain(
      endFirst.body.record.student.id,
    );
    const endedStudent = endFirst.body.record.student.id as string;
    const ended = await api(
      "POST",
      `/usage-records/${endFirst.body.record.id}/end`,
      {
        requestId: randomUUID(),
        previewId: endFirst.body.id,
        expectedVersion: endFirst.body.record.version,
        notes: "",
      },
    );
    expect(ended.status).toBe(200);

    // 第二个人仍在座，且他的记录未被上面那次结束影响。
    const stillActive = await server.db.records.findAll({
      where: { endedAt: null },
    });
    const otherStudent = assigned
      .map((seat) => seat.studentId)
      .find((id) => id !== endedStudent)!;
    expect(stillActive.map((row) => row.get().studentId)).toEqual([
      otherStudent,
    ]);

    // 另一个人也能单独结束。
    const endSecond = await scan({ ...second, scanId: randomUUID() });
    expect(endSecond.status).toBe(200);
    expect(endSecond.body.mode).toBe("end");
    expect(endSecond.body.record.student.id).toBe(otherStudent);
    const endedSecond = await api(
      "POST",
      `/usage-records/${endSecond.body.record.id}/end`,
      {
        requestId: randomUUID(),
        previewId: endSecond.body.id,
        expectedVersion: endSecond.body.record.version,
        notes: "",
      },
    );
    expect(endedSecond.status).toBe(200);
    expect(await server.db.records.count({ where: { endedAt: null } })).toBe(0);
  });

  it("审计只记 ID，不写原卡号或姓名", async () => {
    const rows = await server.db.audits.findAll({
      where: { action: "usage.created" },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.get().studentId).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row.get())).not.toContain("试验组学生");
    }
    const logs = await server.db.logs.findAll();
    for (const row of logs)
      expect(JSON.stringify(row.get())).not.toContain("试验组学生");
  });
});
