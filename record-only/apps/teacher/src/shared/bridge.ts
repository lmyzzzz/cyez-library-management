import { z } from "zod";
import { readerProcessSchema } from "./reader-config.js";
import { identityConfigSchema } from "@record/protocol/identity";
import {
  normalizePin,
  sqlServerProviderSchema,
  listSchema,
  startSchema,
  endSchema,
  noteSchema,
  createDeviceSchema,
  editDeviceSchema,
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
export interface LocalStatus {
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
}
export type TeacherEvent =
  | { type: "scan"; preview: ScanPreview }
  | { type: "notice"; code: string }
  | { type: "changed" };
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
