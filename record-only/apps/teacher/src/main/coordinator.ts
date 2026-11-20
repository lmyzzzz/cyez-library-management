import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";
import { z } from "zod";
import { ClientSDK } from "@record/client-sdk";
import {
  ApiError,
  DEFAULT_LAYOUT_SETTINGS,
  parse,
  type BatchAssignment,
  type BatchSession,
  type LayoutDTO,
  type LayoutSettings,
  type LayoutUpdate,
  type ScanPreview,
  type ServiceStatus,
  type StudentDTO,
} from "@record/protocol";
import type { IdentityConfig } from "@record/protocol/identity";
import {
  actions,
  connectionSchema,
  type ActionName,
  type Connection,
  type GatePage,
  type ScanMode,
  type TeacherEvent,
  type SafeLog,
  type LocalStatus,
} from "../shared/bridge.js";
import { PinnedTransport } from "./transport.js";
import { LocalStore } from "./store.js";
import { CardReader, type CardEvent } from "./reader.js";
/** Failures that mean the server could not be reached or its response was unusable. */
const TRANSPORT_FAILURE_CODES = new Set([
  "NETWORK_TIMEOUT",
  "NETWORK_ABORTED",
  "NETWORK_FAILED",
  "TLS_OR_NETWORK_FAILED",
  "REDIRECT_REFUSED",
  "RESPONSE_INVALID",
  "RESPONSE_TOO_LARGE",
]);
/** Deterministic pre-commit refusals that must not be replayed. */
const DEFINITIVE_REJECTION_CODES = new Set(["STORAGE_WRITE_RESTRICTED"]);
/** 服务端判定批次已过期/已不存在：本地批次随之作废，不再重试。 */
const BATCH_GONE_CODES = new Set(["BATCH_CLOSED", "BATCH_NOT_FOUND"]);
/** 批次本地截止后的兜底宽限：等本地定时器先跑，再让服务端惰性判定。 */
const BATCH_TIMEOUT_GRACE_MS = 1500;
/** setTimeout 的上限（约 24.8 天）：超过时按上限等待，醒来再重新计算。 */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
/** 相邻试验组刷卡后维护的本地批次状态。 */
interface ActiveBatch {
  id: string;
  closesAtMs: number;
  /** 已加入成员的学生 ID，用于本地识别重复卡（服务端仍做最终判定）。 */
  studentIds: string[];
  session: BatchSession;
}
export class Coordinator {
  sdk: ClientSDK | undefined;
  connection: Connection | null = null;
  online = false;
  lastSuccessMs: number | null = null;
  private gate: { page: GatePage; modal: boolean; submitting: boolean } = {
    page: "settings",
    modal: false,
    submitting: false,
  };
  private activeCard: { studentId: string; previewId: string } | null = null;
  /** 相邻试验组批次：批次不是单人流程，所以单独保存，不进 activeCard。 */
  private activeBatch: ActiveBatch | null = null;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  /** 自增令牌：结束/放弃/重建批次后，旧的超时回调或迟到响应一律失效。 */
  private batchGeneration = 0;
  /** 最近一次读到的布局设置，仅用于 status() 展示批次窗口秒数。 */
  private layoutSettings: LayoutSettings | null = null;
  /** 批次窗口秒数：优先取布局设置，未读取时由批次快照推算。 */
  private batchWindowSec: number | null = null;
  private scanRevision = 0;
  private scanning = false;
  private scanMode: ScanMode = "manual";
  private modeChanging = false;
  private completedCard: { id: string; at: number } | null = null;
  private writing = false;
  private recovering = false;
  private flushing = false;
  readonly reader: CardReader;
  readerState = "未连接读卡器";
  constructor(
    readonly store: LocalStore,
    readonly clientId: string,
    readonly environment: "development" | "integration" | "production",
    identity: IdentityConfig | null,
    /** origin="card" 标记由刷卡触发、只应送达刷卡窗口的事件。 */
    private emit: (event: TeacherEvent, origin?: "card") => void,
    private version = "unknown",
  ) {
    this.reader = new CardReader(identity, (event) => this.onCard(event));
  }
  async init() {
    this.scanMode =
      (await this.store.get("scanMode")) === "automatic"
        ? "automatic"
        : "manual";
    const saved = await this.store.get("connection");
    if (saved) {
      try {
        await this.configure(connectionSchema.parse(JSON.parse(saved)));
      } catch {
        this.emit({ type: "notice", code: "CONNECTION_CONFIGURATION_INVALID" });
      }
    }
    await this.log({ source: "main", level: "info", code: "APP_STARTED" });
  }
  async autoLoginOnStartup() {
    if ((await this.store.get("autoLogin")) === "true") {
      try {
        await this.loginSaved();
      } catch {
        this.emit({ type: "notice", code: "AUTO_LOGIN_FAILED" });
      }
    }
  }
  async log(entry: SafeLog) {
    await this.store.append({
      ...entry,
      logId: randomUUID(),
      atMs: Date.now(),
      appVersion: this.version,
    });
  }
  async configure(connection: Connection) {
    this.activeCard = null;
    // 换服务器后旧批次的预览属于旧 origin，必须在本机撤销并清掉定时器。
    this.resetBatch();
    // 布局设置是**每台服务器各自**的，换服务器必须丢弃，否则沿用旧窗口长度。
    this.layoutSettings = null;
    this.batchWindowSec = null;
    this.scanRevision++;
    await this.sdk?.close();
    this.sdk = undefined;
    this.online = false;
    this.connection = connection;
    const transport = new PinnedTransport(connection);
    this.sdk = new ClientSDK(transport, this.clientId);
    await this.store.set("connection", JSON.stringify(connection));
    this.emit({ type: "changed" });
    return { ok: true };
  }
  async status(): Promise<LocalStatus> {
    const metrics = await this.store.metrics();
    const current = this.sdk
      ? (
          await this.store.pending(
            (this.sdk.transport as PinnedTransport).origin,
          )
        ).length
      : 0;
    return {
      scanMode: this.scanMode,
      identityConfigured: this.reader.configured,
      connectionConfigured: !!this.connection,
      authenticated: !!this.sdk?.authenticated,
      online: this.online,
      savedCredentials: !!(await this.store.get("credentials")),
      autoLogin: (await this.store.get("autoLogin")) === "true",
      ...metrics,
      pendingCommands: current,
      pendingOtherOrigins: metrics.pendingCommands - current,
      reader: this.readerState,
      environment: this.environment,
      version: this.version,
      lastSuccessMs: this.lastSuccessMs,
      batchWindowSec:
        this.layoutSettings?.batchWindowSec ?? this.batchWindowSec,
      activeBatchId: this.activeBatch?.id ?? null,
    };
  }
  /** 只用布局设置覆盖批次窗口秒数，不改动其它本地状态。 */
  private rememberLayout(layout: LayoutDTO | undefined) {
    // 响应缺字段时不覆盖缓存：宁可沿用旧值，也不要把 undefined 写进去。
    if (!layout?.settings) return;
    this.layoutSettings = layout.settings;
    this.batchWindowSec = layout.settings.batchWindowSec;
  }
  private requireSdk() {
    if (!this.sdk) throw new ApiError("CONNECTION_REQUIRED", 401);
    return this.sdk;
  }
  private async network<T>(work: () => Promise<T>): Promise<T> {
    try {
      const value = await work();
      this.online = true;
      this.lastSuccessMs = Date.now();
      return value;
    } catch (e) {
      // Reachable-server business errors (401/4xx/5xx responses) stay online;
      // only transport-level failures mean the connection is gone.
      if (!(e instanceof ApiError) || TRANSPORT_FAILURE_CODES.has(e.code)) {
        this.online = false;
        this.emit({ type: "changed" });
      }
      throw e;
    }
  }
  async onCard(event: CardEvent) {
    let ownsScan = false;
    let replaced: string | undefined;
    try {
      // Automatic one-scan completion must not immediately reverse itself when
      // a reader repeats a held card. Require five seconds of quiet for that ID.
      if (this.completedCard?.id === event.studentId) {
        const previous = this.completedCard.at;
        this.completedCard.at = performance.now();
        if (this.completedCard.at - previous < 5000) return;
      }
      const busy =
        this.modeChanging ||
        this.gate.modal ||
        this.gate.submitting ||
        this.writing ||
        this.scanning;
      // 批次页没有单人流程：进入批次时 activeCard 已清空；process 中残留的
      // activeCard 不属于批次页，不能在这里抢走后续刷卡。
      const current =
        this.gate.page === "flow" || this.gate.page === "batch"
          ? this.activeCard
          : null;
      // 相邻试验组批次：门控页是 "batch"，但刷卡继续有效（这就是“继续刷下一个人”）。
      const batch =
        this.gate.page === "batch" && !this.activeCard
          ? this.activeBatch
          : null;
      if (current?.studentId === event.studentId) {
        // 手动模式下再次刷同一张卡等同点击确认：只发确认信号，不重复查询
        // 校园资料、不重新建立预览。自动模式由预览就绪后的自动提交负责，
        // 重复读卡帧不能再次触发，也不能覆盖结果页。
        if (busy) {
          this.emit({ type: "notice", code: "SCAN_RETURN_TO_DEVICES" }, "card");
          return;
        }
        if (!this.online || !this.sdk?.authenticated) {
          this.emit({ type: "notice", code: "OFFLINE_NO_WRITE" }, "card");
          return;
        }
        if (this.scanMode === "manual")
          this.emit({ type: "confirm", previewId: current.previewId }, "card");
        return;
      }
      /*
       * 批次期间刷到已加入的成员：这就是“批次结束信号”，必须交给服务端
       * （`join` 会在识别到重复卡后立即分配并返回 assignment）。客户端不能在
       * 本地只弹一句提示就 return，否则重复刷卡永远触发不了分配。
       */
      if (batch?.studentIds.includes(event.studentId)) {
        this.emit({ type: "notice", code: "BATCH_CLOSING" }, "card");
      }
      if (busy || (!current && this.gate.page !== "devices" && !batch)) {
        this.emit({ type: "notice", code: "SCAN_RETURN_TO_DEVICES" }, "card");
        return;
      }
      if (!this.online || !this.sdk?.authenticated) {
        this.emit({ type: "notice", code: "OFFLINE_NO_WRITE" }, "card");
        return;
      }
      if (current) {
        // 流程中刷了另一张卡：取消当前流程，按新卡重新开始。
        replaced = current.previewId;
        this.activeCard = null;
        void this.sdk
          .call("DELETE", `/api/v1/scan-previews/${replaced}`)
          .catch(() => {});
        // 让撤销请求在本次刷卡处理内先发出（transport 同步记录），再开始新查询。
      }
      this.scanning = true;
      ownsScan = true;
      const revision = this.scanRevision;
      const sdk = this.sdk;
      if (batch) {
        await this.joinBatch(batch, event, revision, sdk);
        return;
      }
      const preview = await this.network(() =>
        sdk.call<ScanPreview>("POST", "/api/v1/scan-previews", event),
      );
      // A late lookup must not reopen a flow after navigation or a session change.
      if (
        revision !== this.scanRevision ||
        sdk !== this.sdk ||
        !sdk.authenticated
      )
        return;
      if (preview.mode === ("batch" as ScanPreview["mode"]))
        return this.startBatch(preview, event);
      this.activeCard = { studentId: event.studentId, previewId: preview.id };
      this.gate.page = "flow";
      this.emit({ type: "scan", preview, scanMode: this.scanMode }, "card");
    } catch (e) {
      // 新卡没有进入流程时，被顶替的旧流程也已取消，刷卡窗口回到等待页。
      if (replaced) this.emit({ type: "cancel", previewId: replaced }, "card");
      this.emit(
        {
          type: "notice",
          code: e instanceof ApiError ? e.code : "SCAN_FAILED",
        },
        "card",
      );
      await this.log({
        source: "reader",
        level: "warn",
        code: "SCAN_FAILED",
        scanId: event.scanId,
      });
    } finally {
      if (ownsScan) this.scanning = false;
      event.card.uidHex = "";
      event.card.issuer = "";
    }
  }
  /**
   * 试验组成员刷卡：服务端返回 mode:"batch" 的预览。批次不是单人流程，
   * 不设置 activeCard，门控页切到 "batch"；后续刷卡都走 join。
   */
  private startBatch(preview: ScanPreview, event: CardEvent) {
    const session =
      preview.batch ?? this.syntheticBatch(preview, event.studentId);
    this.rememberBatchWindow(session);
    this.setActiveBatch(session);
    this.gate = { page: "batch", modal: false, submitting: false };
    this.emit({ type: "batch", session, scanMode: this.scanMode }, "card");
  }
  /** 服务端应在新批次预览里带 batch 字段；缺省时按预览自建一份快照。 */
  private syntheticBatch(
    preview: ScanPreview,
    studentId: string,
  ): BatchSession {
    const windowSec =
      this.batchWindowSec ?? DEFAULT_LAYOUT_SETTINGS.batchWindowSec;
    return {
      id: preview.id,
      mode: "batch",
      atMs: preview.atMs,
      closesAtMs: preview.atMs + windowSec * 1000,
      // 预览里的学生资料由服务端本次刷新得到，本地不缓存也不推断资料。
      students: preview.student ? [{ ...preview.student, id: studentId }] : [],
      duplicates: [],
      state: "collecting",
    };
  }
  /** 批次收集期间刷卡：不再 POST /scan-previews，只向当前批次加入成员。 */
  private async joinBatch(
    batch: ActiveBatch,
    event: CardEvent,
    revision: number,
    sdk: ClientSDK,
  ) {
    const generation = this.batchGeneration;
    const stale = () =>
      revision !== this.scanRevision ||
      sdk !== this.sdk ||
      !sdk.authenticated ||
      generation !== this.batchGeneration;
    let preview: ScanPreview;
    try {
      preview = await this.network(() =>
        sdk.call<ScanPreview>(
          "POST",
          `/api/v1/scan-previews/${batch.id}/join`,
          event,
        ),
      );
    } catch (e) {
      if (stale()) return;
      // 本机定时器可能比服务端先到；截止时间之后再判过期才清本地批次。
      const expired =
        (e instanceof ApiError && BATCH_GONE_CODES.has(e.code)) ||
        Date.now() >= batch.closesAtMs + BATCH_TIMEOUT_GRACE_MS;
      if (!expired) throw e;
      this.endBatch(batch, "timeout");
      return;
    }
    const session = preview.batch ?? null;
    const assignment = (
      preview as ScanPreview & {
        assignment?: BatchAssignment | null;
      }
    ).assignment;
    /*
     * 分配结果来自服务端已提交的事务，**优先于 `stale()` 判断**：
     * 批次刚结束时 renderer 会立刻把门控上报成 devices，`scanRevision` 随之 +1，
     * 若先判 stale 就会把这个迟到但真实的分配结果丢掉，出现“学生已落座、
     * 界面却提示批次已结束”的情况。
     */
    if (assignment) {
      if (this.activeBatch?.id === batch.id) this.resetBatch();
      this.emit({ type: "batchAssigned", assignment }, "card");
      this.emit(
        { type: "batchClosed", batchId: batch.id, reason: "duplicate" },
        "card",
      );
      return;
    }
    if (stale()) return;
    const next = session ?? this.syntheticBatch(preview, event.studentId);
    if (next.state !== "collecting") {
      this.closeBatch(batch.id);
      this.emit(
        { type: "batchClosed", batchId: batch.id, reason: "timeout" },
        "card",
      );
      return;
    }
    this.setActiveBatch(next);
    this.emit({ type: "batchUpdate", session: next }, "card");
  }
  /** 记录当前批次（含截止时间与本地去重用的成员 ID）并重置超时定时器。 */
  private setActiveBatch(session: BatchSession) {
    this.batchGeneration++;
    this.rememberBatchWindow(session);
    this.activeBatch = {
      id: session.id,
      closesAtMs: session.closesAtMs,
      studentIds: session.students.map((student) => student.id),
      session,
    };
    this.scheduleBatchTimeout(session.id, session.closesAtMs);
  }
  /** 还没读到布局设置时，用批次快照推算窗口秒数，供 status() 展示。 */
  private rememberBatchWindow(session: BatchSession) {
    if (this.layoutSettings) return;
    const served = (session.closesAtMs - session.atMs) / 1000;
    if (Number.isInteger(served) && served >= 10 && served <= 600)
      this.batchWindowSec = served;
  }
  /** 本地定时器：到 closesAtMs 主动确认批次，让教师立刻看到分配结果。 */
  private scheduleBatchTimeout(batchId: string, closesAtMs: number) {
    this.clearBatchTimer();
    this.batchTimer = setTimeout(
      () => {
        this.batchTimer = null;
        void this.onBatchTimeout(batchId);
      },
      // +1ms：同一毫秒内醒来时 Date.now() 仍可能早于 closesAtMs。
      Math.min(Math.max(closesAtMs - Date.now(), 0) + 1, MAX_TIMER_DELAY_MS),
    );
    // 批次超时不应该阻止 Electron main 退出。
    this.batchTimer.unref?.();
  }
  private async onBatchTimeout(batchId: string) {
    const batch = this.activeBatch;
    if (!batch || batch.id !== batchId) return;
    // 本地时钟先到：服务端可能还没判定过期，再等一个宽限期让它自己收尾。
    if (Date.now() < batch.closesAtMs) {
      this.scheduleBatchTimeout(batchId, batch.closesAtMs);
      return;
    }
    try {
      this.emit({ type: "notice", code: "BATCH_TIMEOUT_CONFIRMING" }, "card");
      await this.confirmBatch(batchId);
    } catch {
      // 失败保留批次供教师手动重试；定时器不自动重试。
    }
  }
  private clearBatchTimer() {
    if (this.batchTimer === null) return;
    clearTimeout(this.batchTimer);
    this.batchTimer = null;
  }
  /** 撤销本地批次：清定时器与内存状态，不产生事件（调用方各自决定提示）。 */
  private resetBatch() {
    this.batchGeneration++;
    this.clearBatchTimer();
    this.activeBatch = null;
    if (this.gate.page === "batch")
      this.gate = { ...this.gate, page: "devices" };
  }
  /**
   * 结束本地批次。revokeBatch=true 时顺带删除服务端预览（放弃批次）。
   */
  private closeBatch(batchId: string, revokeBatch = false) {
    const batch = this.activeBatch;
    if (!batch || batch.id !== batchId) return false;
    this.resetBatch();
    if (revokeBatch) this.revokeBatch(batchId);
    return true;
  }
  /** 撤销服务端批次预览（放弃或刷卡窗口关闭）。失败只影响服务端 TTL 兜底。 */
  private revokeBatch(batchId: string) {
    if (!this.online || !this.sdk?.authenticated) return;
    void this.sdk
      .call("DELETE", `/api/v1/scan-previews/${batchId}`)
      .catch(() => {});
  }
  /** 超时或服务端判定关闭：清本地批次并在刷卡窗口提示重新刷卡。 */
  private endBatch(batch: ActiveBatch, reason: "timeout") {
    this.closeBatch(batch.id);
    this.emit({ type: "batchClosed", batchId: batch.id, reason }, "card");
    this.emit({ type: "notice", code: "BATCH_EXPIRED" }, "card");
  }
  /**
   * 结束并分配批次（重复卡、超时或教师点击）。走既有 command 幂等管线：
   * 请求体只有 requestId，不含卡号/学生 ID，可以进 intents 表。
   */
  async confirmBatch(batchId: string) {
    const batch = this.activeBatch;
    if (!batch || batch.id !== batchId)
      throw new ApiError("BATCH_NOT_ACTIVE", 409);
    const assignment = (await this.command(
      "POST",
      `/api/v1/batches/${batchId}/confirm`,
      {},
    )) as BatchAssignment;
    this.closeBatch(batchId);
    this.emit({ type: "batchAssigned", assignment }, "card");
    this.emit({ type: "batchClosed", batchId, reason: "manual" }, "card");
    return assignment;
  }
  /** 教师放弃批次：删除服务端预览并清理本地状态，不产生分配结果。 */
  async abandonBatch(batchId: string) {
    if (!this.online || !this.requireSdk().authenticated)
      throw new ApiError("OFFLINE_NO_WRITE", 503);
    await this.network(() =>
      this.sdk!.call("DELETE", `/api/v1/scan-previews/${batchId}`),
    );
    this.closeBatch(batchId);
    this.emit({ type: "batchClosed", batchId, reason: "cancelled" }, "card");
    return { ok: true };
  }
  /** 刷卡窗口关闭或重新加载时调用：停止接收刷卡并撤销未完成的预览与批次。 */
  async releaseScan() {
    const previewId = this.activeCard?.previewId;
    const batchId = this.activeBatch?.id;
    this.gate = { page: "settings", modal: false, submitting: false };
    this.activeCard = null;
    this.scanRevision++;
    if (batchId) {
      this.closeBatch(batchId, true);
      this.emit({ type: "batchClosed", batchId, reason: "cancelled" }, "card");
    }
    if (previewId && this.online && this.sdk?.authenticated)
      await this.sdk
        .call("DELETE", `/api/v1/scan-previews/${previewId}`)
        .catch(() => {});
  }
  async command(method: string, path: string, body: Record<string, unknown>) {
    if (!this.online || !this.requireSdk().authenticated)
      throw new ApiError("OFFLINE_NO_WRITE", 503);
    if (this.writing || this.recovering)
      throw new ApiError("COMMAND_BUSY", 409);
    this.writing = true;
    try {
      const pending = await this.store.pending(
        (this.sdk!.transport as PinnedTransport).origin,
      );
      if (pending.length) throw new ApiError("COMMAND_PENDING", 409);
      const requestId = randomUUID(),
        payload = { ...body, requestId };
      await this.log({
        source: "sdk",
        level: "info",
        code: "COMMAND_PENDING",
        requestId,
      });
      await this.store.saveIntent({
        requestId,
        origin: (this.sdk!.transport as PinnedTransport).origin,
        method,
        path,
        body: payload,
        createdAt: Date.now(),
        state: "pending",
      });
      try {
        const result = await this.network(() =>
          this.sdk!.call(method, path, payload),
        );
        await this.store.write(() =>
          this.store.intents.update(
            { state: "committed" },
            { where: { requestId } },
          ),
        );
        await this.log({
          source: "sdk",
          level: "info",
          code: "COMMAND_COMMITTED",
          requestId,
        });
        return result;
      } catch (e) {
        if (
          e instanceof ApiError &&
          ((e.status >= 400 &&
            e.status < 500 &&
            e.status !== 401 &&
            e.status !== 429) ||
            DEFINITIVE_REJECTION_CODES.has(e.code))
        ) {
          await this.store.write(() =>
            this.store.intents.update(
              { state: "rejected" },
              { where: { requestId } },
            ),
          );
          throw e;
        }
        throw new ApiError("COMMAND_PENDING", 503);
      }
    } finally {
      this.writing = false;
      this.emit({ type: "changed" });
    }
  }
  async recover() {
    if (this.recovering || this.writing) return { busy: true };
    this.recovering = true;
    try {
      const sdk = this.requireSdk();
      const origin = (sdk.transport as PinnedTransport).origin;
      const outcomes = [];
      for (const intent of await this.store.pending(origin)) {
        try {
          let result: unknown;
          try {
            const op = await sdk.call<{ result: unknown }>(
              "GET",
              `/api/v1/operations/${intent.requestId}`,
            );
            result = op.result;
          } catch (e) {
            if (!(e instanceof ApiError) || e.status !== 404) throw e;
            result = await sdk.call(intent.method, intent.path, intent.body);
          }
          await this.store.write(() =>
            this.store.intents.update(
              { state: "committed" },
              { where: { requestId: intent.requestId } },
            ),
          );
          outcomes.push({
            requestId: intent.requestId,
            state: "committed",
            result,
          });
        } catch (e) {
          if (
            e instanceof ApiError &&
            (DEFINITIVE_REJECTION_CODES.has(e.code) ||
              (e.status >= 400 &&
                e.status < 500 &&
                ![401, 429].includes(e.status)))
          ) {
            await this.store.write(() =>
              this.store.intents.update(
                { state: "rejected" },
                { where: { requestId: intent.requestId } },
              ),
            );
            outcomes.push({
              requestId: intent.requestId,
              state: "rejected",
              code: e.code,
            });
          } else throw e;
        }
      }
      return { outcomes };
    } finally {
      this.recovering = false;
      this.emit({ type: "changed" });
    }
  }
  async flush() {
    if (this.flushing || !this.online || !this.sdk?.authenticated) return;
    this.flushing = true;
    try {
      const logs = await this.store.logBatch();
      if (logs.length) {
        const result = await this.sdk.call<{ acked: string[] }>(
          "POST",
          "/api/v1/logs/batch",
          { logs },
        );
        await this.store.ack(
          result.acked.filter((id) => logs.some((l) => l.logId === id)),
        );
      }
    } finally {
      this.flushing = false;
    }
  }
  async login(
    username: string,
    password: string,
    remember: boolean,
    autoLogin = false,
  ) {
    if (autoLogin && !remember)
      throw new ApiError("AUTO_LOGIN_REQUIRES_SAVED_PASSWORD", 422);
    const sdk = this.requireSdk();
    await this.network(() => sdk.login(username, password));
    let saved = false;
    if (remember && safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(
        JSON.stringify({
          origin: (sdk.transport as PinnedTransport).origin,
          username,
          password,
        }),
      );
      try {
        await this.saveLoginSettings(encrypted.toString("base64"), autoLogin);
      } finally {
        encrypted.fill(0);
      }
      saved = true;
    } else {
      await this.saveLoginSettings(null, false);
      if (remember)
        this.emit({ type: "notice", code: "SECURE_STORAGE_UNAVAILABLE" });
    }
    return saved;
  }
  private async saveLoginSettings(
    credentials: string | null,
    autoLogin: boolean,
  ) {
    await this.store.write(() =>
      this.store.db.transaction(async (transaction) => {
        if (credentials)
          await this.store.settings.upsert(
            { key: "credentials", value: credentials },
            { transaction },
          );
        else
          await this.store.settings.destroy({
            where: { key: "credentials" },
            transaction,
          });
        await this.store.settings.upsert(
          { key: "autoLogin", value: String(autoLogin) },
          { transaction },
        );
      }),
    );
  }
  private async finishLogin(saved: boolean) {
    const sdk = this.requireSdk();
    const recovery = await this.recover();
    await sdk.call("POST", "/api/v1/clients/startup", {
      version: this.version,
    });
    await this.flush();
    return { saved, recovery };
  }
  async loginSaved() {
    const stored = await this.store.get("credentials");
    if (!stored || !safeStorage.isEncryptionAvailable())
      throw new ApiError("SAVED_LOGIN_UNAVAILABLE", 401);
    const encrypted = Buffer.from(stored, "base64");
    let credentials: { origin: string; username: string; password: string };
    try {
      credentials = JSON.parse(safeStorage.decryptString(encrypted));
    } finally {
      encrypted.fill(0);
    }
    let saved: boolean;
    try {
      if (
        credentials.origin !==
        (this.requireSdk().transport as PinnedTransport).origin
      )
        throw new ApiError("SAVED_LOGIN_ORIGIN_MISMATCH", 401);
      saved = await this.login(
        credentials.username,
        credentials.password,
        true,
        (await this.store.get("autoLogin")) === "true",
      );
    } finally {
      credentials.password = "";
    }
    return this.finishLogin(saved);
  }
  async call(action: ActionName, input: unknown): Promise<unknown> {
    if (!(action in actions)) throw new ApiError("IPC_ACTION_INVALID", 422);
    if (action === "replaceProviderConfig") {
      let data: Record<string, unknown> | undefined;
      let pending: Promise<unknown>;
      try {
        data = parse(actions.replaceProviderConfig, input);
        // Transport serializes synchronously; never retain this body while awaiting ACK.
        pending = this.network(() =>
          this.requireSdk().call("POST", "/api/v1/provider-config", data),
        );
      } finally {
        for (const object of [input, data])
          if (object && typeof object === "object")
            for (const key of Object.keys(object))
              (object as Record<string, unknown>)[key] = undefined;
      }
      return pending;
    }
    const data = parse(actions[action] as z.ZodTypeAny, input) as Record<
      string,
      unknown
    >;
    if (action === "login" && input && typeof input === "object")
      (input as { password: string }).password = "";
    if (__CYEZ_TEST_FEATURES__ && action === "integrationScan") {
      if (this.environment === "production")
        throw new ApiError("INTEGRATION_DISABLED", 403);
      const uid =
        typeof data.uidHex === "string"
          ? data.uidHex
          : data.fixture === "allowed-1"
            ? "00000001"
            : data.fixture === "allowed-2"
              ? "00000002"
              : "ffffffff";
      await this.reader.accept(Buffer.from(uid, "hex"), "integration");
      return { ok: true };
    }
    switch (action) {
      case "configure":
        return this.configure(data as Connection);
      case "status":
        return this.status();
      case "setScanMode":
        if (
          this.activeCard ||
          this.activeBatch ||
          this.scanning ||
          this.writing ||
          this.recovering ||
          this.modeChanging
        )
          throw new ApiError("SCAN_MODE_BUSY", 409);
        this.modeChanging = true;
        try {
          await this.store.set("scanMode", data.mode as ScanMode);
          this.scanMode = data.mode as ScanMode;
          this.emit({ type: "changed" });
          return { mode: this.scanMode };
        } finally {
          this.modeChanging = false;
        }
      case "gate":
        if (
          data.page !== this.gate.page ||
          data.modal !== this.gate.modal ||
          data.submitting !== this.gate.submitting
        )
          this.scanRevision++;
        this.gate = data as typeof this.gate;
        if (this.gate.page !== "flow") this.activeCard = null;
        // 批次页和流程页一样：休息在其他页面时才放弃批次，避免批次被清洗。
        if (this.gate.page !== "flow" && this.gate.page !== "batch")
          this.resetBatch();
        return { ok: true };
      case "login":
        let saved: boolean;
        try {
          saved = await this.login(
            data.username as string,
            data.password as string,
            data.remember as boolean,
            data.autoLogin as boolean,
          );
        } finally {
          data.password = "";
        }
        return this.finishLogin(saved);
      case "loginSaved":
        return this.loginSaved();
      case "clearSaved":
        await this.saveLoginSettings(null, false);
        return { ok: true };
      case "logout":
        this.activeCard = null;
        // 登出时本地撤销服务端批次预览的引用；令牌随后失效，剩由 TTL 兜底。
        this.resetBatch();
        this.layoutSettings = null;
        this.batchWindowSec = null;
        this.scanRevision++;
        try {
          await this.sdk?.logout();
        } finally {
          // Local logout state must not depend on the server acknowledging it.
          this.online = false;
          await this.store.set("autoLogin", "false");
        }
        return { ok: true };
      case "testConnection":
        return this.network(() =>
          this.requireSdk().transport.request("GET", "/health/ready"),
        );
      case "recover":
        return this.recover();
      case "uiError":
        await this.log({
          source: "renderer",
          level: "error",
          code: "UI_ERROR",
        });
        return { ok: true };
    }
    if (
      action === "cancelPreview" &&
      data.previewId === this.activeCard?.previewId
    )
      this.activeCard = null;
    const sdk = this.requireSdk();
    if (action === "addons")
      return this.network(() => sdk.call("GET", "/api/v1/addons"));
    const query = (value: Record<string, unknown>) =>
      new URLSearchParams(
        Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      ).toString();
    if (action === "devices") {
      const [devices, status] = await this.network(() =>
        Promise.all([
          sdk.call("GET", "/api/v1/devices?" + query(data)),
          sdk.call<ServiceStatus>("GET", "/api/v1/service-status"),
        ]),
      );
      return { devices, status };
    }
    if (action === "history")
      return this.network(() =>
        sdk.call("GET", "/api/v1/usage-records?" + query(data)),
      );
    if (action === "tags")
      return this.network(() => sdk.call("GET", "/api/v1/tags"));
    // 相邻试验组批次：结束/确认走 command 幂等管线，放弃复用预览删除接口。
    if (action === "batchConfirmAssigned")
      return this.confirmBatch(data.batchId as string);
    if (action === "batchClose")
      return this.confirmBatch(data.batchId as string);
    if (action === "batchAbandon")
      return this.abandonBatch(data.batchId as string);
    if (action === "layout") {
      const layout = await this.network(() =>
        sdk.call<LayoutDTO>("GET", "/api/v1/layout"),
      );
      this.rememberLayout(layout);
      return layout;
    }
    if (action === "experimentStudents")
      return this.network(() =>
        sdk.call("GET", "/api/v1/students/experiment?" + query(data)),
      );
    if (!this.online) throw new ApiError("OFFLINE_NO_WRITE", 503);
    if (action === "batchStatus")
      return sdk.call("GET", `/api/v1/batches/${data.batchId}`);
    if (action === "cancelPreview")
      return sdk.call("DELETE", `/api/v1/scan-previews/${data.previewId}`);
    if (action === "endPreview")
      return sdk.call(
        "POST",
        `/api/v1/usage-records/${data.recordId}/end-preview`,
        {},
      );
    if (action === "batchPreview")
      return sdk.call(
        "POST",
        "/api/v1/usage-records/end-batches/preview",
        data,
      );
    if (action === "saveLayout") {
      // 保存成功后立刻更新本机缓存，否则 status()/兜底窗口会一直用旧值。
      const saved = (await this.command(
        "PUT",
        "/api/v1/layout",
        data as LayoutUpdate,
      )) as LayoutDTO;
      this.rememberLayout(saved);
      return saved;
    }
    if (action === "setExperiment") {
      const { studentId, ...body } = data;
      return this.command(
        "PUT",
        `/api/v1/students/${studentId}/experiment`,
        body,
      );
    }
    const { recordId, deviceId, tagId, addonId, ...body } = data;
    switch (action) {
      case "configureAddon":
        return this.command(
          "POST",
          `/api/v1/addons/${addonId}/configure`,
          body,
        );
      case "runAddon":
        return this.command("POST", `/api/v1/addons/${addonId}/run`, body);
      case "disableDevice":
        return this.command(
          "PATCH",
          `/api/v1/devices/${deviceId}/disabled`,
          body,
        );
      case "start":
        return this.finishFlow(
          data.previewId,
          this.command("POST", "/api/v1/usage-records/start", data),
        );
      case "end":
        return this.finishFlow(
          data.previewId,
          this.command("POST", `/api/v1/usage-records/${recordId}/end`, body),
        );
      case "editNotes":
        return this.command(
          "PATCH",
          `/api/v1/usage-records/${recordId}/notes`,
          body,
        );
      case "batchConfirm":
        return this.command(
          "POST",
          "/api/v1/usage-records/end-batches/confirm",
          data,
        );
      case "createDevice":
        return this.command("POST", "/api/v1/devices", data);
      case "editDevice":
        return this.command("PATCH", `/api/v1/devices/${deviceId}`, body);
      case "deleteDevice":
        return this.command("DELETE", `/api/v1/devices/${deviceId}`, body);
      case "createTag":
        return this.command("POST", "/api/v1/tags", data);
      case "editTag":
        return this.command("PATCH", `/api/v1/tags/${tagId}`, body);
      case "deleteTag":
        return this.command("DELETE", `/api/v1/tags/${tagId}`, body);
      default:
        throw new ApiError("IPC_ACTION_INVALID", 422);
    }
  }
  /** 刷卡流程提交成功后立即结束同卡关联，结果页期间的刷卡按新刷卡处理。 */
  private async finishFlow(previewId: unknown, work: Promise<unknown>) {
    const result = await work;
    if (previewId === this.activeCard?.previewId) {
      if (this.scanMode === "automatic")
        this.completedCard = {
          id: this.activeCard!.studentId,
          at: performance.now(),
        };
      this.activeCard = null;
      this.gate.page = "devices";
    }
    return result;
  }
  async close() {
    // 进程退出前不再需要批次定时器；本地批次随进程结束失效。
    this.resetBatch();
    await this.sdk?.close();
    const deadline = Date.now() + 10000;
    while (
      (this.writing || this.scanning || this.recovering || this.flushing) &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 25));
    await this.store.close();
  }
}
