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
  uuid,
  type ScanPreview,
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
    page: z.enum(["devices", "settings", "flow"]),
    modal: z.boolean(),
    submitting: z.boolean(),
  })
  .strict();
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
        integrationScan: z
          .object({ fixture: z.enum(["allowed-1", "allowed-2", "unknown"]) })
          .strict(),
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
  reconnecting: boolean;
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
}
export type TeacherEvent =
  | { type: "scan"; preview: ScanPreview; scanMode: ScanMode }
  /** 手动模式下同一张卡再次刷卡或点击确认按钮时，确认当前预览。 */
  | { type: "confirm"; previewId: string }
  /** 当前流程被另一张卡顶替且新卡未能进入流程时，通知刷卡窗口退出旧流程。 */
  | { type: "cancel"; previewId: string }
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
