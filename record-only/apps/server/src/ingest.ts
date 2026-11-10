import { Database } from "./database.js";
import { Spool } from "./storage.js";
import { readFile } from "node:fs/promises";
import { FileCollector } from "./file-collector.js";
const url = process.env.DATABASE_URL_FILE
  ? (await readFile(process.env.DATABASE_URL_FILE, "utf8")).trim()
  : process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_CONFIGURATION_REQUIRED");
const db = new Database(url);
let stopped = false;
process.once("SIGTERM", () => {
  stopped = true;
});
process.once("SIGINT", () => {
  stopped = true;
});
const diagnostic = "INGEST_SOURCE_INVALID: skipped an invalid source entry.\n";
/** `origin:path` entries; empty entries are skipped and one malformed entry is
 * reported once and skipped instead of creating an unusable source or throwing
 * during startup (which would stop every other source). */
function parseSources(
  value: string | undefined,
  fallback: string,
  kind: "spool" | "file",
) {
  const origin = (entry: string) => {
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator === entry.length - 1) return undefined;
    const source = entry.slice(0, separator).trim(),
      path = entry.slice(separator + 1).trim();
    if (!source || !path) return undefined;
    if (kind === "file" && source !== "gateway" && source !== "db")
      return undefined;
    return { source, path };
  };
  const result: { origin: string; path: string }[] = [];
  for (const raw of (value ?? fallback).split(";")) {
    const entry = raw.trim();
    if (!entry) continue;
    try {
      const parsed = origin(entry);
      if (!parsed) {
        process.stderr.write(diagnostic);
        continue;
      }
      result.push({ origin: parsed.source, path: parsed.path });
    } catch {
      process.stderr.write(diagnostic);
    }
  }
  return result;
}
const sources = parseSources(
  process.env.INGEST_SOURCES,
  "api:runtime/spool",
  "spool",
).map(({ origin, path }) => ({ origin, spool: new Spool(path) }));
const files = parseSources(process.env.INGEST_FILE_SOURCES, "", "file").map(
  ({ origin, path }) =>
    new FileCollector(
      path,
      process.env.INGEST_CURSOR_DIR ?? "runtime/cursors",
      origin as "gateway" | "db",
    ),
);
while (!stopped) {
  try {
    await db.ready();
    for (const source of sources)
      try {
        await source.spool.drain(db, source.origin);
      } catch {
        process.stderr.write("INGEST_UNAVAILABLE: durable source retained.\n");
      }
    for (const collector of files)
      try {
        await collector.drain(db);
      } catch {
        process.stderr.write("INGEST_UNAVAILABLE: durable source retained.\n");
      }
  } catch {
    process.stderr.write("INGEST_UNAVAILABLE: durable source retained.\n");
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
await db.close();
