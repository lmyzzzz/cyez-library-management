import { z } from "zod";
import { readFileSync } from "node:fs";
import { identityConfigSchema } from "@record/protocol/identity";
export const configSchema = z
  .object({
    environment: z.enum(["development", "integration", "production"]),
    port: z.number().int().min(1).max(65535),
    host: z.string(),
    databaseUrl: z.string().url(),
    username: z.string().min(1).max(100),
    password: z.string().min(12).max(1024),
    identity: identityConfigSchema,
    providerMode: z.enum(["fake", "module"]),
    providerModule: z.string().optional(),
    profileContractConfirmed: z.boolean(),
    providerTimeoutMs: z.number().int().positive(),
    previewTtlMs: z.number().int().positive(),
    previewLimit: z.number().int().positive(),
    batchLimit: z.number().int().min(1).max(5000),
    sessionTtlMs: z.number().int().positive(),
    spoolDir: z.string().min(1),
    capacity: z.object({
      warningBytes: z.number().positive(),
      reserveBytes: z.number().positive(),
      recoveryBytes: z.number().positive(),
      oldestWarnMs: z.number().positive(),
    }),
  })
  .superRefine((v, c) => {
    if (
      v.environment === "production" &&
      (v.providerMode === "fake" || !v.profileContractConfirmed)
    )
      c.addIssue({ code: "custom", message: "PRODUCTION_INPUTS_REQUIRED" });
    if (v.providerMode === "module" && !v.providerModule)
      c.addIssue({ code: "custom", message: "PROVIDER_MODULE_REQUIRED" });
    if (
      v.capacity.reserveBytes >= v.capacity.warningBytes ||
      v.capacity.recoveryBytes <= v.capacity.warningBytes
    )
      c.addIssue({ code: "custom", message: "CAPACITY_WATERMARK_ORDER" });
  });
export type Config = z.infer<typeof configSchema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const read = (key: string) =>
    env[`${key}_FILE`]
      ? readFileSync(env[`${key}_FILE`]!, "utf8").trim()
      : env[key];
  const n = (key: string, fallback: number) =>
    env[key] === undefined ? fallback : Number(env[key]);
  return configSchema.parse({
    environment: env.APP_ENV,
    host: env.HOST ?? "0.0.0.0",
    port: n("PORT", 3000),
    databaseUrl: read("DATABASE_URL"),
    username: env.TEACHER_USERNAME,
    password: env.TEACHER_PASSWORD,
    identity: {
      hashVersion: env.HASH_VERSION,
      fixedSaltHex: env.FIXED_SALT_HEX,
      issuer: env.CARD_ISSUER,
      uidByteLengths: env.UID_BYTE_LENGTHS?.split(",").map(Number),
    },
    providerMode: env.PROVIDER_MODE,
    providerModule: env.PROVIDER_MODULE,
    profileContractConfirmed: env.PROFILE_CONTRACT_CONFIRMED === "true",
    providerTimeoutMs: n("PROVIDER_TIMEOUT_MS", 5000),
    previewTtlMs: n("PREVIEW_TTL_MS", 120000),
    previewLimit: n("PREVIEW_LIMIT", 10000),
    batchLimit: n("BATCH_LIMIT", 500),
    sessionTtlMs: n("SESSION_TTL_MS", 3600000),
    spoolDir: env.SPOOL_DIR ?? "runtime/spool",
    capacity: {
      warningBytes: n("CAPACITY_WARNING_BYTES", 1073741824),
      reserveBytes: n("CAPACITY_RESERVE_BYTES", 268435456),
      recoveryBytes: n("CAPACITY_RECOVERY_BYTES", 2147483648),
      oldestWarnMs: n("CAPACITY_OLDEST_WARN_MS", 3600000),
    },
  });
}
