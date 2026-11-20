import { randomUUID } from "node:crypto";
import {
  ApiError,
  type BatchAssignment,
  type RecordDTO,
  type StudentDTO,
} from "@record/protocol";
export interface Context {
  clientId: string;
  sessionId: string;
  username: string;
}
/** 相邻试验组批次的收集状态。`collecting` 仍在收集学生；`closed` 已超过
 * closesAtMs 但尚未分配；`assigned` 已产生分配结果。 */
export type BatchState = "collecting" | "closed" | "assigned";
export interface Intent {
  id: string;
  clientId: string;
  sessionId: string;
  expiresAtMs: number;
  atMs: number;
  mode: "start" | "end" | "batch";
  studentId?: string;
  studentVersion?: number;
  records: RecordDTO[];
  /** 以下字段只在试验组批次预览上出现（mode === "batch"）。 */
  scanId?: string;
  /** 由哪个 studentId 触发（第一位刷卡成员）。 */
  ownerStudentId?: string;
  /** 已收集的批次成员（按加入顺序，去重）。 */
  students?: StudentDTO[];
  /** 重复刷卡被识别为“批次结束信号”的学生，用于结果展示。 */
  duplicates?: StudentDTO[];
  closesAtMs?: number;
  state?: BatchState;
  assignment?: BatchAssignment;
  /** 本次分配对应的 operations.requestId（成功分配后写入）。 */
  assignmentRequestId?: string;
}
export class Previews {
  readonly entries = new Map<string, Intent>();
  constructor(
    private ttl: number,
    private limit: number,
    private now = Date.now,
  ) {}
  prune() {
    const now = this.now();
    // 预览过期即释放意图；批次窗口只控制“能否继续加入”，不延长预览寿命。
    for (const [key, v] of this.entries) {
      if (v.expiresAtMs <= now) {
        this.entries.delete(key);
        continue;
      }
      /*
       * 收集窗口已经过去、却没有任何人再来访问的批次（教师端崩溃/断网后
       * 再没回来）会一直停在 collecting。这里把它的寿命压到最近的一个
       * prune 周期，确保它最终被回收，而不是等到预览 TTL。
       */
      if (
        v.mode === "batch" &&
        v.state === "collecting" &&
        (v.closesAtMs ?? Number.POSITIVE_INFINITY) <= now
      ) {
        v.state = "closed";
        v.expiresAtMs = Math.min(v.expiresAtMs, now + this.ttl);
      }
    }
  }
  create(
    ctx: Context,
    data: Omit<Intent, "id" | "clientId" | "sessionId" | "expiresAtMs">,
  ): Intent {
    this.prune();
    if (this.entries.size >= this.limit)
      throw new ApiError("PREVIEW_CAPACITY", 429);
    const value = {
      ...data,
      id: randomUUID(),
      clientId: ctx.clientId,
      sessionId: ctx.sessionId,
      expiresAtMs: this.now() + this.ttl,
    };
    this.entries.set(value.id, value);
    return value;
  }
  get(id: string, ctx: Context): Intent {
    this.prune();
    const p = this.entries.get(id);
    if (!p) throw new ApiError("PREVIEW_EXPIRED", 410);
    if (p.clientId !== ctx.clientId || p.sessionId !== ctx.sessionId)
      throw new ApiError("PREVIEW_FORBIDDEN", 403);
    return p;
  }
  delete(id: string, ctx: Context) {
    this.get(id, ctx);
    this.entries.delete(id);
  }
  /** 本机（同一 clientId + sessionId）仍在收集、且未过窗口的批次。 */
  collecting(ctx: Context): Intent | undefined {
    this.prune();
    for (const p of this.entries.values())
      if (
        p.mode === "batch" &&
        p.state === "collecting" &&
        p.clientId === ctx.clientId &&
        p.sessionId === ctx.sessionId &&
        (p.closesAtMs ?? 0) > this.now()
      )
        return p;
    return undefined;
  }
}
