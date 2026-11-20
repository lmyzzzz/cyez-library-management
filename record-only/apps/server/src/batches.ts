import { randomUUID } from "node:crypto";
import { Op, type Transaction } from "sequelize";
import {
  ApiError,
  DEFAULT_LAYOUT_SETTINGS,
  layoutSettingsSchema,
  type AdjacencyGrade,
  type BatchAssignment,
  type BatchSession,
  type LayoutDTO,
  type LayoutSettings,
  type StudentDTO,
} from "@record/protocol";
// 设备名里“座位号”的解析统一交给 resolveSeat（三段式编号与描述性名字都支持）。
import { GRADE_LABELS, planSeats, resolveSeat } from "@record/domain";
import type { Database, DeviceRow, UsageRow } from "./database.js";
import type { Context, Intent } from "./previews.js";
import type { Service } from "./service.js";
/** settings 表里保存布局设置的行键。 */
export const LAYOUT_KEY = "layout";
/**
 * 库内还没有布局行时使用的初始值。`BATCH_WINDOW_SEC` / `BATCH_STUDENT_LIMIT`
 * 只在这里生效——它们是**首次初始化**的默认值，一旦设置页保存过就以库内为准。
 */
export function defaultLayout(overrides?: {
  batchWindowSec?: number;
  batchStudentLimit?: number;
}): LayoutSettings {
  return {
    ...DEFAULT_LAYOUT_SETTINGS,
    ...(overrides?.batchWindowSec === undefined
      ? {}
      : { batchWindowSec: overrides.batchWindowSec }),
    ...(overrides?.batchStudentLimit === undefined
      ? {}
      : { batchStudentLimit: overrides.batchStudentLimit }),
  };
}
/** 设置键列表以 protocol 的 schema 为准：schema 新增字段时这里自动跟上，
 * 不需要在服务端再抄一份字段清单。 */
const LAYOUT_KEYS = Object.keys(
  DEFAULT_LAYOUT_SETTINGS,
) as (keyof LayoutSettings)[];
export function pickLayoutSettings(source: LayoutSettings): LayoutSettings {
  const picked = {} as Record<string, number | boolean>;
  for (const key of LAYOUT_KEYS) picked[key] = source[key];
  return picked as unknown as LayoutSettings;
}
/** settings.value 是长度受限的字符串列，所以存 `{ settings, version }` 的 JSON。 */
export function parseLayout(raw: string | undefined | null): LayoutDTO {
  const fallback: LayoutDTO = { settings: defaultLayout(), version: 1 };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as {
      settings?: unknown;
      version?: unknown;
    };
    const settings = layoutSettingsSchema.safeParse(parsed?.settings);
    if (!settings.success) return fallback;
    const version =
      typeof parsed.version === "number" &&
      Number.isInteger(parsed.version) &&
      parsed.version > 0
        ? parsed.version
        : 1;
    return { settings: settings.data, version };
  } catch {
    // 损坏或旧格式的行按默认值处理，写回时会整体覆盖。
    return fallback;
  }
}
export function serializeLayout(value: LayoutDTO): string {
  return JSON.stringify({ settings: value.settings, version: value.version });
}
export interface AssignmentResult {
  batchId: string;
  assignment: ServerAssignment;
  session: BatchSession;
}
/** 分配结果 + 诊断字段。`unresolvedDevices` 是可选的向后兼容扩展：
 * 只有确实有设备名解析不出座位号时才出现，老客户端忽略即可。 */
export type ServerAssignment = BatchAssignment & {
  unresolvedDevices?: string[];
};
/** 事务外的计划阶段结果：事务内只做“锁 + 重新校验 + 写入”。 */
interface PlannedAssignment {
  busy: string[];
  chosen: { studentId: string; device: DeviceRow }[];
  byDevice: Map<string, DeviceRow>;
  grade: AdjacencyGrade;
  span: number;
  requestId?: string;
  /** 候选里名字解析不出座位号的设备（去重排序）；空时不带该字段。 */
  unresolvedDevices?: string[];
}
/** 相邻试验组批次的编排：收集、惰性过期、分配。
 * 状态全部在 Service.previews 的有界内存里；本版没有后台定时器，
 * 过期只在 GET/POST join/close/confirm 时判定。 */
export class Batches {
  constructor(
    readonly service: Service,
    private now: () => number = Date.now,
  ) {}
  private get db(): Database {
    return this.service.db;
  }
  /** 按 id 批量取学生缓存资料，输出顺序跟随入参（已排序）。 */
  async students(ids: string[]): Promise<StudentDTO[]> {
    if (!ids.length) return [];
    const rows = await this.db.students.findAll({
      where: { id: { [Op.in]: ids } },
    });
    const byId = new Map(rows.map((row) => [row.get().id, row.get()]));
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .map((row) => this.service.student(row));
  }
  session(intent: Intent): BatchSession {
    return {
      id: intent.id,
      mode: "batch",
      atMs: intent.atMs,
      closesAtMs: intent.closesAtMs ?? intent.atMs,
      students: [...(intent.students ?? [])],
      duplicates: [...(intent.duplicates ?? [])],
      state: intent.state ?? "collecting",
    };
  }
  /** 惰性过期：now ≥ closesAtMs 即视为关闭。不写库、不分配。
   * 已分配的批次保持 assigned。 */
  close(intent: Intent): Intent {
    if (intent.state === "collecting") intent.state = "closed";
    return intent;
  }
  expired(intent: Intent): boolean {
    return this.now() >= (intent.closesAtMs ?? intent.atMs);
  }
  /** 本机（clientId + sessionId）仍在收集、窗口未过的批次。 */
  collecting(ctx: Context): Intent | undefined {
    return this.service.previews.collecting(ctx);
  }
  /** 加入成员；返回新增学生后的快照。重复成员只是“结束信号”，分配由调用方做。 */
  join(intent: Intent, student: StudentDTO) {
    const limit = this.service.layout().batchStudentLimit;
    const current = intent.students ?? [];
    if (current.some((s) => s.id === student.id)) {
      intent.duplicates = [student];
      return { duplicate: true, session: this.session(intent) };
    }
    if (current.length >= limit) throw new ApiError("BATCH_FULL", 409);
    intent.students = [...current, student];
    return { duplicate: false, session: this.session(intent) };
  }
  /** 分配：先算方案（planSeats 在写事务之外，最坏 ~365ms，绝不占着事务），
   * 再在单事务里按锁顺序重新校验并写 usage_records + 审计。
   * close/confirm 走 operation 管线时由调用方传入事务。 */
  async assign(
    ctx: Context,
    intent: Intent,
    tx?: Transaction,
    requestId?: string,
  ): Promise<AssignmentResult> {
    const members = [...(intent.students ?? [])].map((s) => s.id).sort();
    if (!members.length) throw new ApiError("BATCH_EMPTY", 409);
    // 计划阶段只读，不开事务：已在座成员进 busy，其余必须全部安排到座位。
    const active = await this.db.records.findAll({
      where: { studentId: { [Op.in]: members }, endedAt: null },
      attributes: ["studentId"],
    });
    const busy = active.map((row) => row.get().studentId).sort();
    const pending = members.filter((id) => !busy.includes(id));
    const free = await this.freeDevices();
    const settings = this.service.layout();
    // 名字里解析不出座位号的设备：只用于诊断与教师端提示，不参与相邻判定。
    const unresolvedDevices = [
      ...new Set(
        free
          .filter((device) => resolveSeat(device.code, settings) === null)
          .map((device) => device.code),
      ),
    ].sort();
    // code 原样交给 planSeats（座位号抽取由 resolveSeat 统一负责）。
    const plan =
      pending.length === 0
        ? null
        : planSeats(
            free.map((device) => device.code),
            pending.length,
            settings,
          );
    if (pending.length > 0 && !plan) {
      // 设备数量不够是唯一会阻止分配的硬条件；几何信息缺失不阻止分配。
      throw new ApiError("DEVICE_CAPACITY_INSUFFICIENT", 409);
    }
    /*
     * 设备名里解析不出座位号时**仍然分配**：`specification.md` 要求
     * “若整批都无几何可算，按 clustered/scattered 展示并仍完成分配”。
     * 解析失败的设备通过 `unresolvedDevices` 回传给教师端提示，不阻断业务。
     */
    const planned: PlannedAssignment = {
      busy,
      chosen: [] as { studentId: string; device: DeviceRow }[],
      byDevice: new Map(free.map((device) => [device.id, device])),
      grade: plan?.grade ?? "scattered",
      span: plan?.span ?? 0,
      requestId,
    };
    if (unresolvedDevices.length) planned.unresolvedDevices = unresolvedDevices;
    if (plan) {
      // plan.codes 已按座位序排列，plan.order[i] 是它在候选 codes 里的下标；
      // 用 order 定位设备（编号重复也不串号），学生按 studentId 升序落座。
      if (plan.order.length !== plan.codes.length)
        throw new ApiError("DEVICE_GEOMETRY_INVALID", 409);
      for (const index of plan.order) {
        const device = free[index];
        if (!device) throw new ApiError("DEVICE_GEOMETRY_INVALID", 409);
        planned.chosen.push({
          studentId: pending[planned.chosen.length]!,
          device,
        });
      }
    }
    const run = async (transaction: Transaction) =>
      this.assignInTransaction(ctx, intent, transaction, planned);
    return tx ? run(tx) : this.db.sequelize.transaction(run);
  }
  private async assignInTransaction(
    ctx: Context,
    intent: Intent,
    tx: Transaction,
    plan: PlannedAssignment,
  ): Promise<AssignmentResult> {
    const { busy, chosen, byDevice: byId, requestId } = plan;
    const members = [...(intent.students ?? [])].map((s) => s.id).sort();
    // students 表是缓存：批次内记录快照一次取齐，避免逐条回查。
    const students = new Map(
      (await this.students(members)).map((s) => [s.id, s]),
    );
    const atMs = this.now();
    await this.service.lock(
      tx,
      chosen.map((c) => c.device.id),
      chosen.map((c) => c.studentId),
      [],
    );
    // 锁内重新确认：设备仍可用、学生仍无活动记录；否则整批回滚、保持 collecting。
    for (const { studentId, device } of chosen) {
      const fresh = await this.db.devices.findByPk(device.id, {
        transaction: tx,
      });
      if (!fresh || fresh.get().deletedAt || fresh.get().isDisabled)
        throw new ApiError("DEVICE_UNAVAILABLE", 409);
      /*
       * 只看“当前仍在进行”的占用：已结束的记录不占座，历史里同一台设备、
       * 同一名学生的旧记录不能阻止本次分配。
       */
      const taken = await this.db.records.findOne({
        where: {
          endedAt: null,
          [Op.or]: [{ deviceId: device.id }, { studentId }],
        },
        transaction: tx,
      });
      if (taken) throw new ApiError("TIME_RANGE_CONFLICT", 409);
    }
    const overlaps = chosen.length
      ? await this.db.records.count({
          where: {
            /*
             * 两个条件必须用 `Op.and` 组合：同一个对象里写两个 `[Op.or]`
             * 后者会覆盖前者。区间 [started_at, ended_at) 与本批的 atMs
             * 重叠才算冲突；`ended_at IS NULL` 表示仍在进行，SQL 里 NULL
             * 不满足 `>`，必须显式纳入，否则“在座”的旧占用查不出来。
             */
            [Op.and]: [
              {
                [Op.or]: [
                  { deviceId: { [Op.in]: chosen.map((c) => c.device.id) } },
                  { studentId: { [Op.in]: chosen.map((c) => c.studentId) } },
                ],
              },
              {
                [Op.or]: [
                  { endedAt: null },
                  { endedAt: { [Op.gt]: new Date(atMs) } },
                ],
              },
            ],
          },
          transaction: tx,
        })
      : 0;
    if (overlaps) throw new ApiError("TIME_RANGE_CONFLICT", 409);
    const records: UsageRow[] = [];
    for (const { studentId, device } of chosen) {
      const row = await this.db.records.create(
        {
          id: randomUUID(),
          studentId,
          deviceId: device.id,
          startedAt: new Date(atMs),
          endedAt: null,
          notes: "",
          endReason: null,
          version: 1,
          clientId: ctx.clientId,
          createdAt: new Date(this.now()),
          updatedAt: new Date(this.now()),
        },
        { transaction: tx },
      );
      await this.service.audit(
        ctx,
        "usage.created",
        ["startedAt", "notes"],
        tx,
        {
          requestId,
          studentId,
          deviceId: device.id,
          recordId: row.get().id,
        },
      );
      records.push(row.get());
    }
    const grade: AdjacencyGrade = plan.grade;
    const assignment: ServerAssignment = {
      batchId: intent.id,
      atMs,
      grade,
      gradeLabel: GRADE_LABELS[grade] ?? grade,
      assigned: chosen.map(({ studentId, device }) => ({
        studentId,
        deviceId: device.id,
        code: device.code,
        displayName: device.displayName,
      })),
      busy,
      unresolved: [] as string[],
      span: plan.span,
    };
    if (plan.unresolvedDevices?.length)
      assignment.unresolvedDevices = plan.unresolvedDevices;
    intent.records = records.map((row) => ({
      id: row.id,
      student: students.get(row.studentId)!,
      device: {
        id: row.deviceId,
        code: byId.get(row.deviceId)!.code,
        displayName: byId.get(row.deviceId)!.displayName,
      },
      startedAtMs: row.startedAt.getTime(),
      endedAtMs: null,
      notes: row.notes,
      endReason: null,
      version: row.version,
    }));
    intent.state = "assigned";
    intent.assignment = assignment;
    if (requestId) intent.assignmentRequestId = requestId;
    return { batchId: intent.id, assignment, session: this.session(intent) };
  }
  /** 未删除、未禁用、没有活动记录的设备（按 code 升序，保证可复现）。
   * 计划阶段在事务外读取，事务内重新校验由调用方负责。 */
  private async freeDevices(tx?: Transaction): Promise<DeviceRow[]> {
    const all = await this.db.devices.findAll({
      where: { deletedAt: null, isDisabled: false },
      order: [
        ["code", "ASC"],
        ["id", "ASC"],
      ],
      ...(tx ? { transaction: tx } : {}),
    });
    if (!all.length) return [];
    const active = await this.db.records.findAll({
      where: {
        deviceId: { [Op.in]: all.map((d) => d.get().id) },
        endedAt: null,
      },
      attributes: ["deviceId"],
      ...(tx ? { transaction: tx } : {}),
    });
    const used = new Set(active.map((row) => row.get().deviceId));
    return all.map((row) => row.get()).filter((device) => !used.has(device.id));
  }
}
