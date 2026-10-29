import { z } from "zod";
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
export interface ScanPreview {
  id: string;
  mode: "start" | "end";
  student: StudentDTO;
  atMs: number;
  expiresAtMs: number;
  record: RecordDTO | null;
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
