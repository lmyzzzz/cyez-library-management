import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, hashId, profileSchema, parse } from "@record/protocol";
import { studentId, type IdentityConfig } from "@record/protocol/identity";
import { payloadDigest } from "@record/domain";
import type { Database } from "./database.js";
const row = z
  .object({
    id: hashId,
    hashVersion: z.string(),
    issuer: z.string(),
    profile: profileSchema,
  })
  .strict();
const inputSchema = z
  .object({
    source: z.string().min(1).max(200),
    compatibleIdentityConfirmed: z.literal(true),
    students: z.array(row).min(1).max(100000),
  })
  .strict();
export async function seedStudents(
  db: Database,
  input: unknown,
  identity: IdentityConfig,
) {
  const data = parse(inputSchema, input);
  const ids = new Set<string>();
  for (const s of data.students) {
    if (
      s.hashVersion !== identity.hashVersion ||
      s.issuer !== identity.issuer ||
      ids.has(s.id)
    )
      throw new ApiError("SEED_CONFLICT", 409);
    ids.add(s.id);
  }
  return db.sequelize.transaction(async (transaction) => {
    const fingerprint = payloadDigest("identity", identity);
    const stored = await db.settings.findByPk("identity", {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (stored && stored.get().value !== fingerprint)
      throw new ApiError("IDENTITY_CONFIGURATION_CHANGED", 409);
    if (!stored)
      await db.settings.create(
        { key: "identity", value: fingerprint },
        { transaction },
      );
    let inserted = 0;
    for (const s of [...data.students].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      const digest = payloadDigest("seed", s);
      const previous = await db.students.findByPk(s.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (previous) {
        if (previous.get().seedDigest !== digest)
          throw new ApiError("SEED_CONFLICT", 409);
        continue;
      }
      await db.students.create(
        {
          id: s.id,
          hashVersion: s.hashVersion,
          ...s.profile,
          isEnabled: true,
          profileRefreshedAt: null,
          version: 1,
          seedDigest: digest,
        },
        { transaction },
      );
      inserted++;
    }
    await db.audits.create(
      {
        id: randomUUID(),
        actor: "controlled-seed",
        clientId: randomUUID(),
        requestId: null,
        scanId: null,
        studentId: null,
        recordId: null,
        deviceId: null,
        action: "seed",
        fields: ["students"],
        at: new Date(),
      },
      { transaction },
    );
    return { inserted, unchanged: data.students.length - inserted };
  });
}
export function integrationSeed(identity: IdentityConfig) {
  return {
    source: "explicit integration fixture",
    compatibleIdentityConfirmed: true,
    students: ["00000001", "00000002", "00000003"].map((uidHex) => ({
      id: studentId({ issuer: identity.issuer, uidHex }, identity),
      issuer: identity.issuer,
      hashVersion: identity.hashVersion,
      profile: {
        name: "集成测试学生",
        className: "测试班级",
        schoolNumber: "INTEGRATION",
      },
    })),
  };
}
