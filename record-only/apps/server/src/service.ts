import { randomUUID } from "node:crypto";
import {
  Op,
  Transaction,
  UniqueConstraintError,
  type WhereOptions,
} from "sequelize";
import { z } from "zod";
import {
  ApiError,
  batchJoinSchema,
  scanSchema,
  startSchema,
  endSchema,
  noteSchema,
  createDeviceSchema,
  editDeviceSchema,
  disableDeviceSchema,
  deleteSchema,
  createTagSchema,
  editTagSchema,
  batchPreviewSchema,
  batchConfirmSchema,
  experimentToggleSchema,
  experimentListSchema,
  batchCloseSchema,
  layoutUpdateSchema,
  type StudentDTO,
  type RecordDTO,
  type DeviceDTO,
  type ListQuery,
  type LayoutSettings,
  type LayoutDTO,
  type BatchAssignment,
  type BatchSession,
  type Action,
} from "@record/protocol";
import { studentId } from "@record/protocol/identity";
import {
  SerialKeys,
  payloadDigest,
  assertInterval,
  appendBatchNotes,
  assertAssignable,
} from "@record/domain";
import type { Config } from "./config.js";
import {
  Database,
  type AuditRow,
  type StudentRow,
  type UsageRow,
} from "./database.js";
import { Previews, type Context, type Intent } from "./previews.js";
import {
  Batches,
  defaultLayout,
  parseLayout,
  pickLayoutSettings,
  serializeLayout,
  LAYOUT_KEY,
  type ServerAssignment,
} from "./batches.js";
import { refreshProfile, type CampusProvider } from "./provider.js";
import { Capacity } from "./storage.js";
/** Business identifiers attached to the generic command audit. Only entity IDs
 * are recorded; payload contents (notes, names, card data) never are. */
export interface AuditIds {
  requestId?: string;
  scanId?: string;
  studentId?: string;
  recordId?: string;
  deviceId?: string;
}
export type AuditIdResolver = (
  result: unknown,
  intent?: Intent,
) => AuditIds | Promise<AuditIds>;
export class Service {
  readonly previews: Previews;
  private serial = new SerialKeys();
  private scans = new Map<
    string,
    { identity: string; expires: number; result?: unknown; error?: ApiError }
  >();
  providerHealthy = true;
  constructor(
    readonly db: Database,
    readonly config: Config,
    readonly provider: CampusProvider,
    readonly capacity: Capacity,
    private now = Date.now,
  ) {
    this.previews = new Previews(config.previewTtlMs, config.previewLimit, now);
    this.batches = new Batches(this, now);
  }
  /** 布局设置的内存缓存；写库成功后才更新，读请求不落库。 */
  private layoutCache: LayoutDTO | undefined;
  readonly batches: Batches;
  student(s: StudentRow): StudentDTO {
    return {
      id: s.id,
      name: s.name,
      className: s.className,
      schoolNumber: s.schoolNumber,
      version: s.version,
      refreshedAtMs: s.profileRefreshedAt?.getTime() ?? null,
    };
  }
  async record(r: UsageRow, transaction?: Transaction): Promise<RecordDTO> {
    const s = await this.db.students.findByPk(r.studentId, { transaction });
    const d = await this.db.devices.findByPk(r.deviceId, { transaction });
    if (!s || !d) throw new ApiError("INTEGRITY_ERROR", 503);
    return {
      id: r.id,
      student: this.student(s.get()),
      device: {
        id: d.get().id,
        code: d.get().code,
        displayName: d.get().displayName,
      },
      startedAtMs: r.startedAt.getTime(),
      endedAtMs: r.endedAt?.getTime() ?? null,
      notes: r.notes,
      endReason: r.endReason,
      version: r.version,
    };
  }
  async audit(
    ctx: Context,
    action: string,
    fields: string[],
    transaction: Transaction,
    ids: AuditIds = {},
  ) {
    const values: AuditRow = {
      id: randomUUID(),
      actor: ctx.username,
      clientId: ctx.clientId,
      requestId: ids.requestId ?? null,
      scanId: ids.scanId ?? null,
      studentId: ids.studentId ?? null,
      recordId: ids.recordId ?? null,
      deviceId: ids.deviceId ?? null,
      action,
      fields,
      at: new Date(this.now()),
    };
    await this.db.audits.create(values, { transaction, returning: false });
  }
  /** 布局设置（含批次窗口/上限）。内存缓存，缺省回落到默认值。 */
  layout(): LayoutSettings {
    // 库内没有布局行时，用环境变量里配置的批次参数作为初始值。
    return (
      this.layoutCache?.settings ??
      defaultLayout({
        batchWindowSec: this.config.batchWindowSec,
        batchStudentLimit: this.config.batchStudentLimit,
      })
    );
  }
  batchWindowSec(): number {
    return this.layout().batchWindowSec;
  }
  async layoutDTO(): Promise<LayoutDTO> {
    if (this.layoutCache) return this.layoutCache;
    const row = await this.db.settings.findByPk(LAYOUT_KEY);
    this.layoutCache = parseLayout(row?.get().value);
    return this.layoutCache;
  }
  /** 单实例内的内存缓存；测试/运维改了库里的行时可显式丢弃。 */
  invalidateLayout() {
    this.layoutCache = undefined;
  }
  /** PUT /api/v1/layout：完整覆盖，走既有幂等/审计/日志管线。
   * 设置是全局的（不是 per-client），所以只有版本号做并发保护。 */
  async updateLayout(ctx: Context, data: z.infer<typeof layoutUpdateSchema>) {
    const result = await this.operation(
      ctx,
      "layout.update",
      { requestId: data.requestId },
      "modify",
      async (tx) => {
        const row = await this.db.settings.findByPk(LAYOUT_KEY, {
          transaction: tx,
          lock: tx.LOCK.UPDATE,
        });
        const current = parseLayout(row?.get().value);
        if (current.version !== data.expectedVersion)
          throw new ApiError("LAYOUT_VERSION_CONFLICT", 409);
        // 从已校验的更新载荷里挑出全部设置键（新增字段只需在 schema 加一次）。
        const settings: LayoutSettings = pickLayoutSettings(data);
        const value = serializeLayout({
          settings,
          version: current.version + 1,
        });
        if (value.length > 256) throw new ApiError("INPUT_INVALID", 422);
        if (row) await row.update({ value }, { transaction: tx });
        else
          await this.db.settings.create(
            { key: LAYOUT_KEY, value },
            { transaction: tx },
          );
        return { settings, version: current.version + 1 };
      },
    );
    this.layoutCache = result as LayoutDTO;
    return result;
  }
  /** 相邻试验组学生列表：只读已刷卡的缓存资料，不发校园 API。 */
  async listExperiment(
    ctx: Context,
    query: z.infer<typeof experimentListSchema>,
  ) {
    const conditions: WhereOptions<StudentRow>[] = [{ experimentGroup: true }];
    if (query.search) {
      const q = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`;
      conditions.push({
        [Op.or]: [
          { name: { [Op.iLike]: q } },
          { className: { [Op.iLike]: q } },
          { schoolNumber: { [Op.iLike]: q } },
        ],
      });
    }
    const { rows, count } = await this.db.students.findAndCountAll({
      where: { [Op.and]: conditions },
      order: [
        ["name", "ASC"],
        ["id", "ASC"],
      ],
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    });
    return {
      items: rows.map((row) => ({
        ...this.student(row.get()),
        experimentGroup: true as const,
      })),
      total: count,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
  /** 只允许修改 experimentGroup 一个字段；students 是校园 API 的缓存。 */
  async setExperiment(
    ctx: Context,
    id: string,
    data: z.infer<typeof experimentToggleSchema>,
  ) {
    const auditIds: AuditIds = { studentId: id };
    return this.operation(
      ctx,
      `student.experiment:${id.slice(0, 16)}`,
      data,
      "modify",
      async (tx) => {
        const student = await this.db.students.findByPk(id, {
          transaction: tx,
          lock: tx.LOCK.UPDATE,
        });
        if (!student) throw new ApiError("NOT_FOUND", 404);
        if (student.get().experimentGroup !== data.enabled)
          await student.update(
            { experimentGroup: data.enabled },
            { transaction: tx },
          );
        return { studentId: id, experimentGroup: data.enabled };
      },
      () => auditIds,
    );
  }
  /** 试验组成员刷卡的批次分支：并入本机 collecting 批次或新建一个。
   * 返回结构沿用 ScanPreview，`mode` 为 "batch" 且附带 batch 快照。 */
  private async enterBatch(
    ctx: Context,
    input: z.infer<typeof scanSchema>,
    student: StudentRow,
    atMs: number,
  ) {
    const current = this.batches.collecting(ctx);
    const intent =
      current ??
      this.previews.create(ctx, {
        mode: "batch",
        atMs,
        records: [],
        students: [],
        duplicates: [],
        closesAtMs: atMs + this.batchWindowSec() * 1000,
        state: "collecting",
      });
    const { duplicate } = this.batches.join(intent, this.student(student));
    if (duplicate) {
      // 同一批次又刷到已收集的卡：这是“批次结束”信号，立即分配并返回结果。
      const { assignment, session } = await this.batches.assign(ctx, intent);
      return {
        id: intent.id,
        mode: "end" as const,
        atMs,
        expiresAtMs: intent.expiresAtMs,
        student: this.student(student),
        record: null,
        batch: { ...session, state: "assigned" as const },
        assignment,
      };
    }
    return {
      id: intent.id,
      mode: "batch" as const,
      atMs,
      expiresAtMs: intent.expiresAtMs,
      student: this.student(student),
      record: null,
      batch: this.batches.session(intent),
    };
  }
  /** 每次有效刷卡都要重查校园 API 并刷新缓存（含批次加入）。
   * 与 scan 共用 providerHealthy、版本校验与锁顺序语义。 */
  private async refreshCache(
    ctx: Context,
    input: z.infer<typeof scanSchema>,
    id: string,
    signal?: AbortSignal,
  ): Promise<StudentRow> {
    const before = await this.db.students.findByPk(id);
    let profile;
    try {
      profile = await refreshProfile(
        this.provider,
        input.card,
        this.config.providerTimeoutMs,
        signal,
      );
      this.providerHealthy = true;
    } catch (e) {
      if (
        e instanceof ApiError &&
        (e.code === "STUDENT_NOT_ALLOWED" || e.code === "PROFILE_MISMATCH")
      )
        this.providerHealthy = true;
      else if (!signal?.aborted) this.providerHealthy = false;
      throw e;
    }
    await this.capacity.require("scan");
    signal?.throwIfAborted();
    return this.db.sequelize.transaction(async (transaction) => {
      const current = await this.db.students.findByPk(id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (current?.get().version !== before?.get().version)
        throw new ApiError("PROFILE_VERSION_CONFLICT", 409);
      const values = {
        ...profile,
        hashVersion: input.hashVersion,
        profileRefreshedAt: new Date(this.now()),
        version: (current?.get().version ?? 0) + 1,
      };
      // 缓存覆盖不得触碰 experimentGroup（由教师显式设置）。
      const cached = current
        ? await current.update(values, { transaction })
        : await this.db.students.create(
            {
              id,
              ...values,
              isEnabled: null,
              seedDigest: null,
              experimentGroup: false,
            },
            { transaction },
          );
      await this.audit(
        ctx,
        current ? "profile.refresh" : "profile.cached",
        Object.keys(profile),
        transaction,
        { studentId: id, scanId: input.scanId },
      );
      return cached.get();
    });
  }
  async scan(
    ctx: Context,
    input: z.infer<typeof scanSchema>,
    signal?: AbortSignal,
  ) {
    const atMs = this.now();
    try {
      if (input.hashVersion !== this.config.identity.hashVersion)
        throw new ApiError("HASH_VERSION_UNSUPPORTED", 422);
      let id: string;
      try {
        id = studentId(input.card, this.config.identity);
      } catch {
        throw new ApiError("CARD_FORMAT_INVALID", 422);
      }
      if (id !== input.studentId) throw new ApiError("CARD_ID_MISMATCH", 422);
      if (
        input.source === "integration" &&
        this.config.environment === "production"
      )
        throw new ApiError("INPUT_INVALID", 422);
      const key = `${ctx.clientId}:${input.scanId}`;
      const identity = id + ":" + input.hashVersion;
      return await this.serial.run("scan:" + key, async () => {
        for (const [k, v] of this.scans)
          if (v.expires <= this.now()) this.scans.delete(k);
        const old = this.scans.get(key);
        if (old) {
          if (old.identity !== identity)
            throw new ApiError("SCAN_ID_REUSED", 409);
          if (old.error) throw old.error;
          return old.result;
        }
        if (this.scans.size >= this.config.previewLimit)
          throw new ApiError("SCAN_CAPACITY", 429);
        const entry: {
          identity: string;
          expires: number;
          result?: unknown;
          error?: ApiError;
        } = { identity, expires: this.now() + this.config.previewTtlMs };
        this.scans.set(key, entry);
        try {
          entry.result = await this.serial.run("student:" + id, async () => {
            await this.capacity.require("scan");
            signal?.throwIfAborted();
            const s = await this.refreshCache(ctx, input, id, signal);
            const active = await this.db.records.findOne({
              where: { studentId: id, endedAt: null },
            });
            // 试验组成员且当前不在座：不分配设备，进批次收集（或并入本机窗口内的批次）。
            if (s.experimentGroup && !active)
              return await this.enterBatch(ctx, input, s, atMs);
            const record = active ? await this.record(active.get()) : null;
            const p = this.previews.create(ctx, {
              mode: record ? "end" : "start",
              atMs,
              studentId: id,
              studentVersion: s.version,
              records: record ? [record] : [],
            });
            return {
              id: p.id,
              mode: p.mode,
              student: this.student(s),
              atMs,
              expiresAtMs: p.expiresAtMs,
              record,
            };
          });
          return entry.result;
        } catch (e) {
          entry.error =
            e instanceof ApiError ? e : new ApiError("SCAN_FAILED", 503);
          throw entry.error;
        }
      });
    } finally {
      input.card.uidHex = "";
      input.card.issuer = "";
    }
  }
  /** POST /api/v1/scan-previews/:id/join：批次窗口内继续刷卡。
   * 每次有效刷卡都重算 studentId、重查校园资料并刷新缓存。 */
  async batchJoin(
    ctx: Context,
    previewId: string,
    input: z.infer<typeof batchJoinSchema>,
    signal?: AbortSignal,
  ) {
    const atMs = this.now();
    try {
      if (input.hashVersion !== this.config.identity.hashVersion)
        throw new ApiError("HASH_VERSION_UNSUPPORTED", 422);
      let id: string;
      try {
        id = studentId(input.card, this.config.identity);
      } catch {
        throw new ApiError("CARD_FORMAT_INVALID", 422);
      }
      if (id !== input.studentId) throw new ApiError("CARD_ID_MISMATCH", 422);
      if (
        input.source === "integration" &&
        this.config.environment === "production"
      )
        throw new ApiError("INPUT_INVALID", 422);
      return await this.serial.run("batch:" + previewId, async () => {
        if (!this.previews.entries.has(previewId))
          throw new ApiError("BATCH_NOT_FOUND", 404);
        const intent = this.previews.get(previewId, ctx);
        if (intent.mode !== "batch") throw new ApiError("BATCH_NOT_FOUND", 404);
        if (intent.state === "assigned" && intent.assignment)
          return {
            id: intent.id,
            mode: "end" as const,
            atMs: intent.assignment.atMs,
            expiresAtMs: intent.expiresAtMs,
            batch: this.batches.session(intent),
            assignment: intent.assignment,
          };
        // 惰性过期：now ≥ closesAtMs 即视为关闭（先确认状态再判定）。
        const expired = this.batches.expired(intent);
        if (expired) this.batches.close(intent);
        /*
         * 重复卡只是“批次结束信号”：规格明确它不重新查询校园资料。
         * 这里先按 studentId 判定，命中就直接分配并返回；只有新成员才查
         * 校园 API，避免校园接口抖动导致“刷重复卡结束不了批次”。
         */
        const repeated = (intent.students ?? []).find((s) => s.id === id);
        if (repeated && !expired && intent.state === "collecting") {
          // 记录“这次刷卡是重复卡”，教师端据此说明批次为何结束。
          intent.duplicates = [repeated];
          const { assignment, session } = await this.batches.assign(
            ctx,
            intent,
          );
          return {
            id: intent.id,
            mode: "end" as const,
            atMs,
            expiresAtMs: intent.expiresAtMs,
            student: repeated,
            batch: { ...session, state: "assigned" as const },
            assignment,
          };
        }
        await this.capacity.require("scan");
        signal?.throwIfAborted();
        const s = await this.serial.run("student:" + id, () =>
          this.refreshCache(ctx, input, id, signal),
        );
        // 只有“本次开始时窗口还没过”才允许继续加入；过期一律 410。
        if (expired || intent.state !== "collecting")
          throw new ApiError("BATCH_CLOSED", 410);
        if (!s.experimentGroup)
          throw new ApiError("EXPERIMENT_GROUP_DISABLED", 422);
        const { duplicate, session } = this.batches.join(
          intent,
          this.student(s),
        );
        if (duplicate) {
          const { assignment } = await this.batches.assign(ctx, intent);
          return {
            id: intent.id,
            mode: "end" as const,
            atMs: atMs,
            expiresAtMs: intent.expiresAtMs,
            batch: { ...session, state: "assigned" as const },
            assignment,
          };
        }
        return {
          id: intent.id,
          mode: "batch" as const,
          atMs,
          expiresAtMs: intent.expiresAtMs,
          student: this.student(s),
          batch: this.batches.session(intent),
        };
      });
    } finally {
      input.card.uidHex = "";
      input.card.issuer = "";
    }
  }
  /** 批次当前状态；过期即视为 closed（惰性判定，无后台调度）。 */
  async batchStatus(ctx: Context, id: string): Promise<BatchSession> {
    const intent = this.previews.get(id, ctx);
    if (intent.mode !== "batch") throw new ApiError("BATCH_NOT_FOUND", 404);
    // 已分配的批次保持 assigned；只有还在收集的批次会被惰性标成 closed。
    if (this.batches.expired(intent)) this.batches.close(intent);
    return this.batches.session(intent);
  }
  /** 教师结束批次并分配。close 与 confirm 等价，共用 operations.intentId
   * 唯一约束：同一预览只能分配一次（换 requestId 也是 PREVIEW_ALREADY_USED）。 */
  async batchAssign(
    ctx: Context,
    route: string,
    id: string,
    data: z.infer<typeof batchCloseSchema>,
  ): Promise<ServerAssignment> {
    if (!this.previews.entries.has(id))
      throw new ApiError("BATCH_NOT_FOUND", 404);
    const result = (await this.operation(
      ctx,
      route,
      { requestId: data.requestId, previewId: id },
      "modify",
      async (tx) => {
        const intent = this.previews.get(id, ctx);
        if (intent.mode !== "batch")
          throw new ApiError("PREVIEW_MODE_INVALID", 409);
        if (intent.state === "assigned" && intent.assignment)
          return intent.assignment;
        /*
         * 已过期或已被判关闭的批次不能再分配：`specification.md` 规定
         * “结束后的批次再结束返回 BATCH_CLOSED”。以前这里会继续走 assign，
         * 教师拿到的是 DEVICE_CAPACITY_INSUFFICIENT 之类的误导性错误。
         */
        if (this.batches.expired(intent)) this.batches.close(intent);
        if (intent.state !== "collecting")
          throw new ApiError("BATCH_CLOSED", 410);
        const { assignment } = await this.batches.assign(
          ctx,
          intent,
          tx,
          data.requestId,
        );
        return assignment;
      },
      (value) => ({
        requestId: data.requestId,
        studentId: (value as ServerAssignment).assigned[0]?.studentId,
        deviceId: (value as ServerAssignment).assigned[0]?.deviceId,
      }),
    )) as ServerAssignment;
    return result;
  }
  /** 批次分配成功后的结果快照（供前端在 assigned 后刷新活动记录）。 */
  async batchAssignment(ctx: Context, id: string) {
    const intent = this.previews.get(id, ctx);
    if (intent.mode !== "batch") throw new ApiError("BATCH_NOT_FOUND", 404);
    return {
      session: this.batches.session(intent),
      assignment: intent.assignment ?? null,
    };
  }
  async operation(
    ctx: Context,
    route: string,
    payload: { requestId: string; previewId?: string },
    action: Action,
    work: (tx: Transaction, p?: Intent) => Promise<unknown>,
    auditIds?: AuditIds | AuditIdResolver,
  ) {
    const digest = payloadDigest(route, payload),
      key = `${ctx.clientId}:${payload.requestId}`;
    return this.serial.run("operation:" + key, async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const old = await this.db.operations.findOne({
          where: { clientId: ctx.clientId, requestId: payload.requestId },
        });
        if (old) {
          if (old.get().digest !== digest || old.get().route !== route)
            throw new ApiError("REQUEST_ID_REUSED", 409);
          return old.get().result;
        }
        if (
          payload.previewId &&
          (await this.db.operations.findOne({
            where: { intentId: payload.previewId },
          }))
        )
          throw new ApiError("PREVIEW_ALREADY_USED", 409);
        await this.capacity.require(action);
        const p = payload.previewId
          ? this.previews.get(payload.previewId, ctx)
          : undefined;
        try {
          return await this.db.sequelize.transaction(async (transaction) => {
            const result = await work(transaction, p);
            const resolvedIds =
              typeof auditIds === "function"
                ? await auditIds(result, p)
                : (auditIds ?? {});
            await this.audit(ctx, route, [], transaction, {
              ...resolvedIds,
              requestId: payload.requestId,
            });
            const logId = randomUUID();
            await this.db.logs.create(
              {
                id: randomUUID(),
                origin: "api",
                logId,
                entry: {
                  logId,
                  source: "api",
                  level: "info",
                  atMs: this.now(),
                  appVersion: "0.1.0",
                  code: "COMMAND_COMMITTED",
                  requestId: payload.requestId,
                },
                receivedAt: new Date(this.now()),
              },
              { transaction },
            );
            await this.db.operations.create(
              {
                id: randomUUID(),
                clientId: ctx.clientId,
                requestId: payload.requestId,
                intentId: payload.previewId ?? null,
                route,
                digest,
                result,
                createdAt: new Date(this.now()),
              },
              { transaction },
            );
            return result;
          });
        } catch (e) {
          const code = (e as { parent?: { code?: string } }).parent?.code;
          if (
            (code === "40P01" ||
              code === "40001" ||
              e instanceof UniqueConstraintError) &&
            attempt < 2
          )
            continue;
          if (e instanceof UniqueConstraintError)
            throw new ApiError("CONCURRENT_CONFLICT", 409);
          throw e;
        }
      }
      throw new ApiError("CONCURRENT_CONFLICT", 409);
    });
  }
  async lock(
    tx: Transaction,
    deviceIds: string[],
    studentIds: string[],
    recordIds: string[],
  ) {
    for (const id of [...new Set(deviceIds)].sort())
      await this.db.devices.findByPk(id, {
        transaction: tx,
        lock: tx.LOCK.UPDATE,
      });
    for (const id of [...new Set(studentIds)].sort())
      await this.db.students.findByPk(id, {
        transaction: tx,
        lock: tx.LOCK.UPDATE,
      });
    for (const id of [...new Set(recordIds)].sort())
      await this.db.records.findByPk(id, {
        transaction: tx,
        lock: tx.LOCK.UPDATE,
      });
  }
  async checkProfile(p: Intent, tx: Transaction) {
    if (!p.studentId) return;
    const s = await this.db.students.findByPk(p.studentId, { transaction: tx });
    if (!s || s.get().hashVersion !== this.config.identity.hashVersion)
      throw new ApiError("STUDENT_NOT_ALLOWED", 403);
    if (s.get().version !== p.studentVersion)
      throw new ApiError("PROFILE_VERSION_CONFLICT", 409);
  }
  async start(ctx: Context, data: z.infer<typeof startSchema>) {
    return this.operation(
      ctx,
      "usage.start",
      data,
      "start",
      async (tx, p) => {
        if (p?.mode !== "start" || !p.studentId)
          throw new ApiError("PREVIEW_MODE_INVALID", 409);
        await this.lock(tx, [data.deviceId], [p.studentId], []);
        await this.checkProfile(p, tx);
        const device = await this.db.devices.findByPk(data.deviceId, {
          transaction: tx,
        });
        if (!device) throw new ApiError("NOT_FOUND", 404);
        const active = await this.db.records.findOne({
          where: {
            endedAt: null,
            [Op.or]: [{ deviceId: data.deviceId }, { studentId: p.studentId }],
          },
          transaction: tx,
        });
        assertAssignable(device.get(), !!active);
        const overlaps = await this.db.records.count({
          where: {
            [Op.or]: [{ deviceId: data.deviceId }, { studentId: p.studentId }],
            endedAt: { [Op.gt]: new Date(p.atMs) },
          },
          transaction: tx,
        });
        if (overlaps) throw new ApiError("TIME_RANGE_CONFLICT", 409);
        const r = await this.db.records.create(
          {
            id: randomUUID(),
            studentId: p.studentId,
            deviceId: data.deviceId,
            startedAt: new Date(p.atMs),
            endedAt: null,
            notes: data.notes,
            endReason: null,
            version: 1,
            clientId: ctx.clientId,
            createdAt: new Date(this.now()),
            updatedAt: new Date(this.now()),
          },
          { transaction: tx },
        );
        await this.audit(ctx, "usage.created", ["startedAt", "notes"], tx, {
          requestId: data.requestId,
          studentId: p.studentId,
          deviceId: data.deviceId,
          recordId: r.get().id,
        });
        return { recordId: r.get().id, version: 1 };
      },
      (result, p) => ({
        recordId: (result as { recordId?: string }).recordId,
        studentId: p?.studentId,
        deviceId: data.deviceId,
      }),
    );
  }
  async endPreview(ctx: Context, id: string) {
    const r = await this.db.records.findByPk(id);
    if (!r) throw new ApiError("NOT_FOUND", 404);
    if (r.get().endedAt) throw new ApiError("HISTORY_READ_ONLY", 409);
    const record = await this.record(r.get());
    const p = this.previews.create(ctx, {
      mode: "end",
      atMs: this.now(),
      records: [record],
    });
    return {
      id: p.id,
      mode: "end",
      atMs: p.atMs,
      expiresAtMs: p.expiresAtMs,
      record,
    };
  }
  async end(ctx: Context, id: string, data: z.infer<typeof endSchema>) {
    return this.operation(
      ctx,
      "usage.end:" + id,
      data,
      "end",
      async (tx, p) => {
        if (
          p?.mode !== "end" ||
          p.records[0]?.id !== id ||
          p.records[0].version !== data.expectedVersion
        )
          throw new ApiError("PREVIEW_MODE_INVALID", 409);
        await this.finish(ctx, p, data.notes, false, tx, data.requestId);
        return { recordId: id, version: data.expectedVersion + 1 };
      },
      (_result, p) => {
        const record = p?.records.find((r) => r.id === id);
        return {
          recordId: id,
          studentId: p?.studentId,
          deviceId: record?.device.id,
        };
      },
    );
  }
  async finish(
    ctx: Context,
    p: Intent,
    notes: string,
    batch: boolean,
    tx: Transaction,
    requestId: string,
  ) {
    await this.lock(
      tx,
      p.records.map((r) => r.device.id),
      p.records.map((r) => r.student.id),
      p.records.map((r) => r.id),
    );
    await this.checkProfile(p, tx);
    for (const previous of p.records) {
      const model = await this.db.records.findByPk(previous.id, {
        transaction: tx,
      });
      if (!model) throw new ApiError("NOT_FOUND", 404);
      const r = model.get();
      if (
        r.endedAt ||
        r.version !== previous.version ||
        r.deviceId !== previous.device.id ||
        r.studentId !== previous.student.id
      )
        throw new ApiError("RECORD_VERSION_CONFLICT", 409);
      assertInterval(r.startedAt.getTime(), p.atMs);
      await model.update(
        {
          endedAt: new Date(p.atMs),
          notes: batch ? appendBatchNotes(r.notes, notes) : notes,
          endReason: batch ? "batch" : p.studentId ? "scan" : "manual",
          version: r.version + 1,
          updatedAt: new Date(this.now()),
        },
        { transaction: tx },
      );
      await this.audit(
        ctx,
        "usage.ended",
        ["endedAt", "notes", "endReason"],
        tx,
        {
          requestId,
          recordId: r.id,
          deviceId: r.deviceId,
          studentId: r.studentId,
        },
      );
    }
  }
  async editNotes(ctx: Context, id: string, data: z.infer<typeof noteSchema>) {
    const auditIds: AuditIds = { recordId: id };
    return this.operation(
      ctx,
      "usage.notes:" + id,
      data,
      "modify",
      async (tx) => {
        const initial = await this.db.records.findByPk(id, { transaction: tx });
        if (!initial) throw new ApiError("NOT_FOUND", 404);
        auditIds.deviceId = initial.get().deviceId;
        auditIds.studentId = initial.get().studentId;
        await this.lock(
          tx,
          [initial.get().deviceId],
          [initial.get().studentId],
          [id],
        );
        const r = (await this.db.records.findByPk(id, { transaction: tx }))!;
        if (r.get().endedAt) throw new ApiError("HISTORY_READ_ONLY", 409);
        if (r.get().version !== data.expectedVersion)
          throw new ApiError("RECORD_VERSION_CONFLICT", 409);
        await r.update(
          {
            notes: data.notes,
            version: data.expectedVersion + 1,
            updatedAt: new Date(this.now()),
          },
          { transaction: tx },
        );
        return { recordId: id, version: data.expectedVersion + 1 };
      },
      () => auditIds,
    );
  }
  private async recordWhere(
    filter: Partial<ListQuery>,
    state = "ended",
  ): Promise<WhereOptions<UsageRow>> {
    const conditions: WhereOptions<UsageRow>[] = [];
    if (state === "active") conditions.push({ endedAt: null });
    else if (state === "ended") conditions.push({ endedAt: { [Op.ne]: null } });
    if (filter.deviceId) conditions.push({ deviceId: filter.deviceId });
    if (filter.deviceSearch) {
      const pattern = `%${filter.deviceSearch.replace(/[\\%_]/g, "\\$&")}%`;
      const devices = await this.db.devices.findAll({
        where: {
          [Op.or]: [
            { code: { [Op.iLike]: pattern } },
            { displayName: { [Op.iLike]: pattern } },
          ],
        },
        attributes: ["id"],
      });
      conditions.push({
        deviceId: { [Op.in]: devices.map((d) => d.get().id) },
      });
    }
    if (filter.from !== undefined)
      conditions.push({ startedAt: { [Op.gte]: new Date(filter.from) } });
    if (filter.to !== undefined)
      conditions.push({ startedAt: { [Op.lte]: new Date(filter.to) } });
    if (filter.tagId) {
      const links = await this.db.links.findAll({
        where: { tagId: filter.tagId },
      });
      conditions.push({
        deviceId: { [Op.in]: links.map((l) => l.get().deviceId) },
      });
    }
    if (filter.search) {
      const q = `%${filter.search.replace(/[\\%_]/g, "\\$&")}%`;
      const students = await this.db.students.findAll({
        where: {
          [Op.or]: [
            { name: { [Op.iLike]: q } },
            { className: { [Op.iLike]: q } },
            { schoolNumber: { [Op.iLike]: q } },
          ],
        },
        attributes: ["id"],
      });
      conditions.push({
        studentId: { [Op.in]: students.map((s) => s.get().id) },
      });
    }
    return { [Op.and]: conditions };
  }
  async listRecords(query: ListQuery) {
    const where = await this.recordWhere(query, query.state ?? "ended");
    const { rows, count } = await this.db.records.findAndCountAll({
      where,
      order: [
        ["endedAt", "DESC"],
        ["id", "ASC"],
      ],
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    });
    return {
      items: await Promise.all(rows.map((r) => this.record(r.get()))),
      total: count,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
  async batchPreview(ctx: Context, data: z.infer<typeof batchPreviewSchema>) {
    const atMs = this.now();
    const where =
      data.scope === "selected"
        ? { id: { [Op.in]: data.recordIds! }, endedAt: null }
        : await this.recordWhere(
            data.scope === "filtered" ? (data.filter ?? {}) : {},
            "active",
          );
    const records = await this.db.records.findAll({
      where,
      order: [["id", "ASC"]],
    });
    if (
      data.scope === "selected" &&
      records.length !== new Set(data.recordIds).size
    )
      throw new ApiError("RECORD_VERSION_CONFLICT", 409);
    this.previews.prune();
    if (
      this.previews.entries.size +
        Math.ceil(records.length / this.config.batchLimit) >
      this.config.previewLimit
    )
      throw new ApiError("PREVIEW_CAPACITY", 429);
    const units = [];
    for (
      let offset = 0;
      offset < records.length;
      offset += this.config.batchLimit
    ) {
      const dtos = await Promise.all(
        records
          .slice(offset, offset + this.config.batchLimit)
          .map((r) => this.record(r.get())),
      );
      const p = this.previews.create(ctx, {
        mode: "batch",
        atMs,
        records: dtos,
      });
      units.push({ id: p.id, atMs, expiresAtMs: p.expiresAtMs, records: dtos });
    }
    return { units, total: records.length, scope: data.scope };
  }
  async batchConfirm(ctx: Context, data: z.infer<typeof batchConfirmSchema>) {
    return this.operation(ctx, "usage.batch", data, "end", async (tx, p) => {
      if (p?.mode !== "batch") throw new ApiError("PREVIEW_MODE_INVALID", 409);
      await this.finish(ctx, p, data.notes, true, tx, data.requestId);
      return { recordIds: p.records.map((r) => r.id), count: p.records.length };
    });
  }
  async listDevices(query: ListQuery) {
    const conditions: WhereOptions[] = [{ deletedAt: null }];
    if (query.search) {
      const search = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`;
      conditions.push({
        [Op.or]: [
          { code: { [Op.iLike]: search } },
          { displayName: { [Op.iLike]: search } },
        ],
      });
    }
    if (query.tagId) {
      const links = await this.db.links.findAll({
        where: { tagId: query.tagId },
      });
      conditions.push({ id: { [Op.in]: links.map((l) => l.get().deviceId) } });
    }
    if (query.state === "active" || query.state === "free") {
      const active = await this.db.records.findAll({
        where: { endedAt: null },
        attributes: ["deviceId"],
      });
      conditions.push({
        id: {
          [query.state === "active" ? Op.in : Op.notIn]: active.map(
            (r) => r.get().deviceId,
          ),
        },
      });
    }
    const { rows, count } = await this.db.devices.findAndCountAll({
      where: { [Op.and]: conditions },
      order: [
        ["code", "ASC"],
        ["id", "ASC"],
      ],
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    });
    const items: DeviceDTO[] = await Promise.all(
      rows.map(async (row) => {
        const d = row.get();
        const links = await this.db.links.findAll({
          where: { deviceId: d.id },
        });
        const tags = await this.db.tags.findAll({
          where: { id: { [Op.in]: links.map((l) => l.get().tagId) } },
          order: [["name", "ASC"]],
        });
        const active = await this.db.records.findOne({
          where: { deviceId: d.id, endedAt: null },
        });
        return {
          id: d.id,
          code: d.code,
          displayName: d.displayName,
          notes: d.notes,
          isDisabled: d.isDisabled,
          deletedAtMs: d.deletedAt?.getTime() ?? null,
          version: d.version,
          tags: tags.map((t) => ({
            id: t.get().id,
            name: t.get().name,
            version: t.get().version,
          })),
          active: active ? await this.record(active.get()) : null,
        };
      }),
    );
    return { items, total: count, page: query.page, pageSize: query.pageSize };
  }
  async disableDevice(
    ctx: Context,
    id: string,
    data: z.infer<typeof disableDeviceSchema>,
  ) {
    return this.operation(
      ctx,
      `device.disable:${id}`,
      data,
      "modify",
      async (tx) => {
        const device = await this.db.devices.findByPk(id, {
          transaction: tx,
          lock: tx.LOCK.UPDATE,
        });
        if (!device || device.get().deletedAt)
          throw new ApiError("NOT_FOUND", 404);
        if (device.get().version !== data.expectedVersion)
          throw new ApiError("DEVICE_VERSION_CONFLICT", 409);
        if (
          data.isDisabled &&
          (await this.db.records.count({
            where: { deviceId: id, endedAt: null },
            transaction: tx,
          }))
        )
          throw new ApiError("DEVICE_IN_USE", 409);
        await device.update(
          { isDisabled: data.isDisabled, version: device.get().version + 1 },
          { transaction: tx },
        );
        return {
          deviceId: id,
          version: device.get().version,
          isDisabled: device.get().isDisabled,
        };
      },
      { deviceId: id },
    );
  }
  async device(
    ctx: Context,
    id: string | null,
    data:
      | z.infer<typeof createDeviceSchema>
      | z.infer<typeof editDeviceSchema>
      | z.infer<typeof deleteSchema>,
    remove = false,
  ) {
    return this.operation(
      ctx,
      `device.${remove ? "delete" : id ? "edit" : "create"}:${id ?? ""}`,
      data,
      "modify",
      async (tx) => {
        let model = id
          ? await this.db.devices.findByPk(id, {
              transaction: tx,
              lock: tx.LOCK.UPDATE,
            })
          : null;
        if (id) {
          if (!model || model.get().deletedAt)
            throw new ApiError("NOT_FOUND", 404);
          if (
            !("expectedVersion" in data) ||
            model.get().version !== data.expectedVersion
          )
            throw new ApiError("DEVICE_VERSION_CONFLICT", 409);
        }
        if (remove) {
          if (
            await this.db.records.count({
              where: { deviceId: id!, endedAt: null },
              transaction: tx,
            })
          )
            throw new ApiError("DEVICE_IN_USE", 409);
          await model!.update(
            {
              deletedAt: new Date(this.now()),
              version: model!.get().version + 1,
            },
            { transaction: tx },
          );
          return { deviceId: id, deleted: true };
        }
        if (!("code" in data)) throw new ApiError("INPUT_INVALID");
        if (
          id &&
          data.isDisabled &&
          (await this.db.records.count({
            where: { deviceId: id, endedAt: null },
            transaction: tx,
          }))
        )
          throw new ApiError("DEVICE_IN_USE", 409);
        const tagIds = [...new Set(data.tagIds)].sort();
        const tags = await this.db.tags.findAll({
          where: { id: { [Op.in]: tagIds } },
          order: [["id", "ASC"]],
          transaction: tx,
          lock: tx.LOCK.UPDATE,
        });
        if (tags.length !== tagIds.length)
          throw new ApiError("TAG_NOT_FOUND", 409);
        const values = {
          code: data.code,
          displayName: data.displayName,
          notes: data.notes,
          isDisabled: data.isDisabled,
        };
        if (model)
          await model.update(
            { ...values, version: model.get().version + 1 },
            { transaction: tx },
          );
        else
          model = await this.db.devices.create(
            { ...values, id: randomUUID(), version: 1, deletedAt: null },
            { transaction: tx },
          );
        await this.db.links.destroy({
          where: { deviceId: model.get().id },
          transaction: tx,
        });
        await this.db.links.bulkCreate(
          tagIds.map((tagId) => ({ deviceId: model!.get().id, tagId })),
          { transaction: tx },
        );
        return { deviceId: model.get().id, version: model.get().version };
      },
      (result) => ({
        deviceId: (result as { deviceId?: string }).deviceId,
      }),
    );
  }
  async tag(
    ctx: Context,
    id: string | null,
    data:
      | z.infer<typeof createTagSchema>
      | z.infer<typeof editTagSchema>
      | z.infer<typeof deleteSchema>,
    remove = false,
  ) {
    return this.operation(
      ctx,
      `tag.${remove ? "delete" : id ? "edit" : "create"}:${id ?? ""}`,
      data,
      "modify",
      async (tx) => {
        const tag = id
          ? await this.db.tags.findByPk(id, {
              transaction: tx,
              lock: tx.LOCK.UPDATE,
            })
          : null;
        if (id) {
          if (!tag) throw new ApiError("NOT_FOUND", 404);
          if (
            !("expectedVersion" in data) ||
            tag.get().version !== data.expectedVersion
          )
            throw new ApiError("TAG_VERSION_CONFLICT", 409);
        }
        if (remove) {
          await this.db.links.destroy({
            where: { tagId: id! },
            transaction: tx,
          });
          await tag!.destroy({ transaction: tx });
          return { tagId: id, deleted: true };
        }
        if (!("name" in data)) throw new ApiError("INPUT_INVALID");
        const values = {
          name: data.name,
          normalizedName: data.name
            .normalize("NFKC")
            .toLocaleLowerCase("en-US"),
        };
        const t = tag
          ? await tag.update(
              { ...values, version: tag.get().version + 1 },
              { transaction: tx },
            )
          : await this.db.tags.create(
              { ...values, id: randomUUID(), version: 1 },
              { transaction: tx },
            );
        return { tagId: t.get().id, version: t.get().version };
      },
    );
  }
}
