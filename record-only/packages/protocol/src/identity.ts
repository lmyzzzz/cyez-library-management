import { createHash } from "node:crypto";
import { z } from "zod";

export const identityConfigSchema = z
  .object({
    hashVersion: z.string().min(1).max(40),
    fixedSaltHex: z.string().regex(/^(?:[0-9a-f]{2}){16,128}$/),
    issuer: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/),
    uidByteLengths: z.array(z.number().int().min(1).max(128)).min(1),
  })
  .strict();
export type IdentityConfig = z.infer<typeof identityConfigSchema>;
export interface CardScanInput {
  issuer: string;
  uidHex: string;
}

export function studentId(
  input: CardScanInput,
  config: IdentityConfig,
): string {
  identityConfigSchema.parse(config);
  if (
    input.issuer !== config.issuer ||
    !/^(?:[0-9a-f]{2})+$/.test(input.uidHex) ||
    !config.uidByteLengths.includes(input.uidHex.length / 2)
  ) {
    throw new Error("CARD_FORMAT_INVALID");
  }
  const uid = Buffer.from(input.uidHex, "hex");
  const fields = [
    Buffer.from(config.hashVersion),
    Buffer.from(config.fixedSaltHex, "hex"),
    Buffer.from(input.issuer),
    uid,
  ];
  const hash = createHash("sha256").update(
    "cyez-record-only/student-id\0",
    "ascii",
  );
  try {
    for (const field of fields) {
      const size = Buffer.alloc(4);
      size.writeUInt32BE(field.length);
      hash.update(size).update(field);
    }
    return hash.digest("hex");
  } finally {
    uid.fill(0);
  }
}
