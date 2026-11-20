import { z } from "zod";
import { readerProcessSchema } from "./reader-config.js";
import { identityConfigSchema } from "@record/protocol/identity";
import type { WindowState } from "./windows.js";
import {
  normalizePin,
  sqlServerProviderSchema,
  listSchema,
  startSchema,
  endSchema,
  noteSchema,
  createDeviceSchema,
  editDeviceSchema,
  disableDeviceSchema,
  configureAddonSchema,
  addonIdSchema,
  deleteSchema,
  createTagSchema,
  editTagSchema,
  batchPreviewSchema,
  batchConfirmSchema,
  batchCloseSchema,
  layoutUpdateSchema,
  experimentToggleSchema,
  experimentListSchema,
  uuid,
  type ScanPreview,
  type BatchSession,
  type BatchAssignment,
  type AppLog,
} from "@record/protocol";
export const connectionSchema = z
  .object({
    ip: z.string().min(1).max(45),
    port: z.number().int().min(1).max(65535),
    pin: z.string().transform(normalizePin),
  })
  .strict();
export type Connection = z.infer<typeof connectionSchema>;
export const gateSchema = z
  .object({
    /// batch：相邻试验组的批次收集页（非单人流程，没有 activeCard）。
    page: z.enum(["devices", "settings", "flow", "batch"]),
    modal: z.boolean(),
    submitting: z.boolean(),
  })
  .strict();
export type GatePage = z.infer<typeof gateSchema>["page"];
export const actions = {
  initializeClient: identityConfigSchema,
  configure: connectionSchema,
  login: z
    .object({
      username: z.string().min(1).max(100),
      password: z.string().max(1024),
      remember: z.boolean(),
      autoLogin: z.boolean().default(false),
    })
    .strict(),
  loginSaved: z.object({}).strict(),
  clearSaved: z.object({}).strict(),
  configureReader: readerProcessSchema,
  replaceProviderConfig: sqlServerProviderSchema,
  listSerialPorts: z.object({}).strict(),
  listAcr1552Readers: z.object({}).strict(),
  testConnection: z.object({}).strict(),
  logout: z.object({}).strict(),
  status: z.object({}).strict(),
  setScanMode: z.object({ mode: z.enum(["manual", "automatic"]) }).strict(),
  addons: z.object({}).strict(),
  configureAddon: configureAddonSchema
    .omit({ requestId: true })
    .extend({ addonId: addonIdSchema }),
  runAddon: z.object({ addonId: addonIdSchema }).strict(),
  disableDevice: disableDeviceSchema
    .omit({ requestId: true })
    .extend({ deviceId: uuid }),
  recover: z.object({}).strict(),
  gate: gateSchema,
  devices: listSchema,
  history: listSchema,
  tags: z.object({}).strict(),
  start: startSchema.omit({ requestId: true }),
  end: endSchema.omit({ requestId: true }).extend({ recordId: uuid }),
  endPreview: z.object({ recordId: uuid }).strict(),
  editNotes: noteSchema.omit({ requestId: true }).extend({ recordId: uuid }),
  createDevice: createDeviceSchema.omit({ requestId: true }),
  editDevice: editDeviceSchema
    .omit({ requestId: true })
    .extend({ deviceId: uuid }),
  deleteDevice: deleteSchema
    .omit({ requestId: true })
    .extend({ deviceId: uuid }),
  createTag: createTagSchema.omit({ requestId: true }),
  editTag: editTagSchema.omit({ requestId: true }).extend({ tagId: uuid }),
  deleteTag: deleteSchema.omit({ requestId: true }).extend({ tagId: uuid }),
  batchPreview: batchPreviewSchema,
  batchConfirm: batchConfirmSchema.omit({ requestId: true }),
  /// 相邻试验组批次：只发无卡号的结束/确认/放弃请求，走 command 或只读代理。
  batchStatus: z.object({ batchId: uuid }).strict(),
  batchClose: batchCloseSchema.omit({ requestId: true }).extend({
    batchId: uuid,
  }),
  batchConfirmAssigned: batchConfirmSchema
    .pick({ requestId: true })
    .extend({ batchId: uuid }),
  batchAbandon: z.object({ batchId: uuid }).strict(),
  /// 座位布局与批次设置（docs/adjacent-layout.md §4、§5）。
  layout: z.object({}).strict(),
  saveLayout: layoutUpdateSchema.omit({ requestId: true }),
  experimentStudents: experimentListSchema,
  setExperiment: experimentToggleSchema
    .omit({ requestId: true })
    .extend({ studentId: uuid }),
  cancelPreview: z.object({ previewId: uuid }).strict(),
  uiError: z.object({}).strict(),
  windowState: z.object({}).strict(),
  setAuxWindow: z
    .object({ window: z.enum(["scan", "status"]), open: z.boolean() })
    .strict(),
  setScanAutoFocus: z.object({ enabled: z.boolean() }).strict(),
  setScanFullscreen: z.object({ enabled: z.boolean() }).strict(),
  moveScanDisplay: z.object({}).strict(),
  auxCommand: z
    .object({
      command: z.enum(["minimize", "toggleFullscreen", "openSettings"]),
    })
    .strict(),
  ...(__CYEZ_TEST_FEATURES__
    ? {
        /**
         * 集成/测试构建专用：注入一次刷卡。`fixture` 是三个固定假卡，
         * `uidHex` 允许直接指定 4 字节 UID，便于演示多名学生连刷。
         */
        integrationScan: z
          .object({
            fixture: z.enum(["allowed-1", "allowed-2", "unknown"]).optional(),
            uidHex: z
              .string()
              .regex(/^(?:[0-9a-f]{2}){4}$/)
              .optional(),
          })
          .strict()
          .refine((value) => !!(value.fixture || value.uidHex), {
            message: "SCAN_INPUT_REQUIRED",
          }),
      }
    : {}),
} as const;
export type ActionName = keyof typeof actions;
export type ActionInput<K extends ActionName> = z.input<
  NonNullable<(typeof actions)[K]>
>;
/** 登记模式：手动由教师确认，自动在预览就绪后立即提交一次。 */
export type ScanMode = "manual" | "automatic";
export interface LocalStatus {
  scanMode: ScanMode;
  identityConfigured: boolean;
  connectionConfigured: boolean;
  authenticated: boolean;
  online: boolean;
  savedCredentials: boolean;
  autoLogin: boolean;
  pendingCommands: number;
  pendingOtherOrigins: number;
  pendingLogs: number;
  oldestLogAgeMs: number;
  storage: "normal" | "warning" | "failed";
  reader: string;
  environment: string;
  version: string;
  lastSuccessMs: number | null;
  /**
   * 批次窗口秒数（来自服务端布局设置）；未登录或尚未读取时为 null。
   * 只用于等待页的文案提示，真正的截止时间以批次快照的 closesAtMs 为准。
   */
  batchWindowSec?: number | null;
  /** 当前收集中的批次号；没有批次时为 null。 */
  activeBatchId?: string | null;
}
/** 批次结束原因：刷到重复卡 / 窗口超时（含服务端判定过期）/ 教师手动结束或放弃。 */
export type BatchCloseReason = "duplicate" | "timeout" | "manual" | "cancelled";
export type TeacherEvent =
  | { type: "scan"; preview: ScanPreview; scanMode: ScanMode }
  /** 手动模式下同一张卡再次刷卡或点击确认按钮时，确认当前预览。 */
  | { type: "confirm"; previewId: string }
  /** 当前流程被另一张卡顶替且新卡未能进入流程时，通知刷卡窗口退出旧流程。 */
  | { type: "cancel"; previewId: string }
  /**
   * 相邻试验组的批次开始。批次不是单人流程，刷卡窗口据此切到批次页；
   * scanMode 只是如实上报当前登记模式，批次本身不受手动/自动影响。
   */
  | { type: "batch"; session: BatchSession; scanMode: ScanMode }
  /** 批次内又加入了成员，或已由服务端刷新出的最新批次快照。 */
  | { type: "batchUpdate"; session: BatchSession }
  /** 批次结束并分配完成（重复卡、超时或教师确认）。 */
  | { type: "batchAssigned"; assignment: BatchAssignment }
  /** 批次在没有分配结果的情况下结束（超时、教师放弃或服务端已关闭）。 */
  | { type: "batchClosed"; batchId: string; reason: BatchCloseReason }
  | { type: "notice"; code: string }
  | { type: "changed" }
  | { type: "windows"; state: WindowState }
  | { type: "openWindowSettings" };
export interface TeacherBridge {
  call<T = unknown, K extends ActionName = ActionName>(
    action: K,
    input: ActionInput<K>,
  ): Promise<T>;
  subscribe(listener: (event: TeacherEvent) => void): () => void;
}
export type SafeLog = Pick<
  AppLog,
  "source" | "level" | "code" | "requestId" | "scanId" | "recordId"
>;
