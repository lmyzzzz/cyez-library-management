import { z } from "zod";
import {
  ADJACENCY_GRADES,
  isValidSection1End,
  isValidSection1Start,
  isValidSection2Start,
  isValidSection3Start,
  type AdjacencyGrade,
  type AdjacencyRelation,
  type LayoutSettings,
} from "./adjacency.js";

/**
 * 相邻几何与座位规划的唯一实现（纯函数，无 Node API 依赖），
 * 放在 protocol 便于教师端 renderer 直接使用。
 */
// 几何算法、等级常量与 LayoutSettings 等类型都来自 ./adjacency.js（单一实现）。
export * from "./adjacency.js";
export type { AdjacencyGrade, AdjacencyRelation };
export { ADJACENCY_GRADES };
export const uuid = z.string().uuid();
export const hashId = z.string().regex(/^[0-9a-f]{64}$/);
export const notes = z.string().max(8000);
export const version = z.number().int().positive();
export const ms = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const profileSchema = z
  .object({
    name: z.string().min(1).max(100),
    className: z.string().max(100),
    schoolNumber: z.string().max(100),
  })
  .strict();
export type Profile = z.infer<typeof profileSchema>;
export const sqlServerProviderSchema = z
  .object({
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[A-Za-z0-9.:-]+$/),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1).max(128),
    password: z.string().min(1).max(1024),
    caPem: z
      .string()
      .max(16384)
      .refine(
        (value) =>
          value === "" ||
          /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(
            value,
          ),
      ),
    tlsValidation: z.enum(["verify", "trustServerCertificate"]).optional(),
    uidEncoding: z.enum(["hex8", "decimal"]),
  })
  .strict()
  .refine(
    (value) =>
      value.tlsValidation !== "trustServerCertificate" || value.caPem === "",
    {
      message: "CA_NOT_USED_WITH_TRUST_SERVER_CERTIFICATE",
      path: ["caPem"],
    },
  );
export type SqlServerProviderConfig = z.infer<typeof sqlServerProviderSchema>;
export const studentSchema = profileSchema.extend({
  id: hashId,
  version,
  refreshedAtMs: ms.nullable(),
});
export type StudentDTO = z.infer<typeof studentSchema>;
export interface TagDTO {
  id: string;
  name: string;
  version: number;
}
export interface DeviceDTO {
  id: string;
  code: string;
  displayName: string;
  notes: string;
  isDisabled: boolean;
  deletedAtMs: number | null;
  version: number;
  tags: TagDTO[];
  active: RecordDTO | null;
}
export interface RecordDTO {
  id: string;
  student: StudentDTO;
  device: { id: string; code: string; displayName: string };
  startedAtMs: number;
  endedAtMs: number | null;
  notes: string;
  endReason: string | null;
  version: number;
}
export const adjacencyGradeSchema = z.enum(ADJACENCY_GRADES);
export interface BatchSession {
  id: string;
  mode: "batch";
  atMs: number;
  closesAtMs: number;
  students: StudentDTO[];
  duplicates: StudentDTO[];
  state: "collecting" | "closed" | "assigned";
}
export interface ScanPreview {
  id: string;
  mode: "start" | "end";
  student: StudentDTO;
  atMs: number;
  expiresAtMs: number;
  record: RecordDTO | null;
  /** 相邻试验组成员刷卡时携带的批次快照；普通学生为 null/缺省。 */
  batch?: BatchSession | null;
}
export interface BatchAssignment {
  batchId: string;
  atMs: number;
  grade: AdjacencyGrade;
  gradeLabel: string;
  assigned: {
    studentId: string;
    deviceId: string;
    code: string;
    displayName: string;
  }[];
  busy: string[];
  unresolved: string[];
  span: number;
}
export interface EndPreview {
  id: string;
  mode: "end";
  atMs: number;
  expiresAtMs: number;
  record: RecordDTO;
}
export interface BatchUnit {
  id: string;
  atMs: number;
  expiresAtMs: number;
  records: RecordDTO[];
}
export interface BatchPreview {
  units: BatchUnit[];
  total: number;
  scope: "all" | "selected" | "filtered";
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export const loginSchema = z
  .object({
    username: z.string().min(1).max(100),
    password: z.string().min(1).max(1024),
    clientId: uuid,
  })
  .strict();
export const scanSchema = z
  .object({
    scanId: uuid,
    studentId: hashId,
    hashVersion: z.string().min(1).max(40),
    card: z
      .object({
        issuer: z.string().max(80),
        uidHex: z.string().regex(/^(?:[0-9a-f]{2}){1,128}$/),
      })
      .strict(),
    source: z.enum(["reader", "integration"]),
  })
  .strict();
export const startSchema = z
  .object({ requestId: uuid, previewId: uuid, deviceId: uuid, notes })
  .strict();
export const endSchema = z
  .object({ requestId: uuid, previewId: uuid, expectedVersion: version, notes })
  .strict();
export const noteSchema = z
  .object({ requestId: uuid, expectedVersion: version, notes })
  .strict();
export const deviceFields = {
  code: z.string().trim().min(1).max(60),
  displayName: z.string().trim().min(1).max(120),
  notes,
  isDisabled: z.boolean(),
  tagIds: z.array(uuid).max(50),
};
export const createDeviceSchema = z
  .object({ ...deviceFields, requestId: uuid })
  .strict();
export const editDeviceSchema = createDeviceSchema.extend({
  expectedVersion: version,
});
export const disableDeviceSchema = z
  .object({
    requestId: uuid,
    expectedVersion: version,
    isDisabled: z.boolean(),
  })
  .strict();
export const addonIdSchema = z.enum(["end-grade-1-2", "end-grade-3"]);
export type AddonId = z.infer<typeof addonIdSchema>;
export const configureAddonSchema = z
  .object({
    requestId: uuid,
    expectedVersion: version,
    enabled: z.boolean(),
  })
  .strict();
export const runAddonSchema = z.object({ requestId: uuid }).strict();
export interface AddonDTO {
  id: AddonId;
  name: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  version: number;
  lastRun: { atMs: number; trigger: "cron" | "manual"; count: number } | null;
}
export const deleteSchema = z
  .object({ requestId: uuid, expectedVersion: version })
  .strict();
export const createTagSchema = z
  .object({ requestId: uuid, name: z.string().trim().min(1).max(80) })
  .strict();
export const editTagSchema = createTagSchema.extend({
  expectedVersion: version,
});
export const filterSchema = z
  .object({
    deviceSearch: z.string().max(100).optional(),
    search: z.string().max(100).optional(),
    tagId: uuid.optional(),
    deviceId: uuid.optional(),
    from: z.coerce.number().int().nonnegative().optional(),
    to: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();
export const listSchema = filterSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
  state: z.enum(["all", "active", "free", "ended"]).optional(),
});
export type ListQuery = z.infer<typeof listSchema>;
export const batchPreviewSchema = z
  .object({
    scope: z.enum(["all", "selected", "filtered"]),
    recordIds: z.array(uuid).max(10000).optional(),
    filter: filterSchema.optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.scope === "selected" && !v.recordIds?.length)
      c.addIssue({ code: "custom", message: "SELECTION_REQUIRED" });
    if (v.scope !== "selected" && v.recordIds)
      c.addIssue({ code: "custom", message: "INVALID_SCOPE" });
    if (v.scope !== "filtered" && v.filter)
      c.addIssue({ code: "custom", message: "INVALID_SCOPE" });
  });
export const batchConfirmSchema = z
  .object({ requestId: uuid, previewId: uuid, notes })
  .strict();
/**
 * docs/adjacent-layout.md §4：布局与批次设置。
 * 三个区域的起点与宽度规则复用 ./adjacency.js 的 `isValidSection1Start` /
 * `isValidSection1End` / `isValidSection2Start` / `isValidSection3Start`，
 * 保证 schema 与纯函数判据完全一致。
 */
export const layoutSettingsSchema = z
  .object({
    /**
     * 区域一的第一个编号，默认 1（现场可改）。区域一占
     * `[section1Start, section1Start + section1End − 1)`。
     */
    section1Start: z.number().refine(isValidSection1Start, {
      message: "SECTION1_START_INVALID",
    }),
    /**
     * 区域一边界宽度 S1 = 区域一桌数 × 4：4 的倍数且 8 ≤ S1 ≤ 96
     * （至少两张完整四角桌）。起点为 1、S1=8 时可用 1..7。
     */
    section1End: z.number().refine(isValidSection1End, {
      message: "SECTION1_END_INVALID",
    }),
    /**
     * 区域二的第一个编号，默认 31（现场可改）。两排从同一起点编号：
     * `start` 与 `start + 1` 正对，`start + 2` 回到上一排的下一列。
     */
    section2Start: z.number().refine(isValidSection2Start, {
      message: "SECTION2_START_INVALID",
    }),
    /**
     * 区域三起点 S3：41 ≤ S3 ≤ 9960 且 `(S3 − 41) % 4 === 0`（41、45、49…），
     * 保证区域三从一张完整桌子的第一个角开始编号。
     * 42 会让第一张桌子只剩 3 个角，因此非法。
     */
    section3Start: z.number().refine(isValidSection3Start, {
      message: "SECTION3_START_INVALID",
    }),
    allowCrossArea: z.boolean(),
    batchWindowSec: z.number().int().min(10).max(600),
    batchStudentLimit: z.number().int().min(2).max(12),
  })
  .strict();
export const DEFAULT_LAYOUT_SETTINGS: LayoutSettings = {
  section1Start: 1,
  section1End: 8,
  section2Start: 31,
  section3Start: 41,
  allowCrossArea: true,
  batchWindowSec: 10,
  batchStudentLimit: 8,
};
export const layoutUpdateSchema = z
  .object({
    requestId: uuid,
    expectedVersion: version,
    ...layoutSettingsSchema.shape,
  })
  .strict();
export type LayoutUpdate = z.infer<typeof layoutUpdateSchema>;
export interface LayoutDTO {
  settings: LayoutSettings;
  version: number;
}
export const batchJoinSchema = scanSchema;
export const batchCloseSchema = z.object({ requestId: uuid }).strict();
export const batchAssignConfirmSchema = z.object({ requestId: uuid }).strict();
export const experimentToggleSchema = z
  .object({ requestId: uuid, enabled: z.boolean() })
  .strict();
export const experimentListSchema = z
  .object({
    search: z.string().max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export type ExperimentListQuery = z.infer<typeof experimentListSchema>;
export const logCodes = [
  "APP_STARTED",
  "APP_STOPPED",
  "CONNECTED",
  "DISCONNECTED",
  "AUTH_REQUIRED",
  "READER_READY",
  "READER_FAILED",
  "SCAN_REJECTED",
  "SCAN_FAILED",
  "COMMAND_PENDING",
  "COMMAND_COMMITTED",
  "COMMAND_REJECTED",
  "STORAGE_WARNING",
  "STORAGE_RESTRICTED",
  "STORAGE_FAILED",
  "STORAGE_RECOVERED",
  "UI_ERROR",
  "API_REQUEST_FAILED",
  "ADDON_RUN_FAILED",
  "PROVIDER_CONFIGURATION_INVALID",
  "PROVIDER_CONFIGURATION_SAVE_FAILED",
  "GATEWAY_ACCESS",
  "DATABASE_EVENT",
  "INSTALL_EVENT",
] as const;
export const logSchema = z
  .object({
    logId: uuid,
    source: z.enum([
      "main",
      "renderer",
      "reader",
      "sdk",
      "installer",
      "api",
      "gateway",
      "db",
    ]),
    level: z.enum(["info", "warn", "error"]),
    atMs: ms,
    appVersion: z.string().regex(/^[0-9A-Za-z.+_-]{1,40}$/),
    code: z.enum(logCodes),
    requestId: uuid.optional(),
    scanId: uuid.optional(),
    recordId: uuid.optional(),
  })
  .strict();
export type AppLog = z.infer<typeof logSchema>;
export const logBatchSchema = z
  .object({ logs: z.array(logSchema).min(1).max(200) })
  .strict();
export type Action = "read" | "scan" | "start" | "end" | "modify";
export interface ServiceStatus {
  mode: "normal" | "warning" | "restricted" | "failed";
  allowedActions: Action[];
  reasonCodes: string[];
  environment: "development" | "integration" | "production";
}
export class ApiError extends Error {
  constructor(
    public code: string,
    public status = 422,
  ) {
    super(code);
    this.name = "ApiError";
  }
}
export function parse<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError("INPUT_INVALID", 422);
  return result.data;
}
export function normalizePin(value: string): string {
  const pin = value.replace(/:/g, "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pin)) throw new ApiError("PIN_INVALID");
  return pin;
}
