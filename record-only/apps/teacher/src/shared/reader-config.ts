import { z } from "zod";

export const readerProcessSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mock") }).strict(),
  z
    .object({ kind: z.literal("external"), executable: z.string().min(1) })
    .strict(),
  z
    .object({
      kind: z.literal("serial"),
      port: z
        .string()
        .trim()
        .regex(/^COM[1-9][0-9]{0,3}$/i)
        .transform((port) => port.toUpperCase()),
      baudRate: z.number().int().min(300).max(921600),
      dataBits: z.union([
        z.literal(5),
        z.literal(6),
        z.literal(7),
        z.literal(8),
      ]),
      parity: z.enum(["none", "odd", "even"]),
      stopBits: z.union([z.literal(1), z.literal(2)]),
      flowControl: z.enum(["none", "hardware", "software"]),
      format: z
        .enum(["hex8", "hex", "decimal", "octal", "binary"])
        .default("hex8"),
    })
    .strict(),
]);
export type ReaderProcessConfig = z.infer<typeof readerProcessSchema>;
