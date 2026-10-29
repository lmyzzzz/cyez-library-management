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
const sources = (process.env.INGEST_SOURCES ?? "api:runtime/spool")
  .split(";")
  .map((v) => {
    const i = v.indexOf(":");
    return { origin: v.slice(0, i), spool: new Spool(v.slice(i + 1)) };
  });
const files = (process.env.INGEST_FILE_SOURCES ?? "")
  .split(";")
  .filter(Boolean)
  .map((v) => {
    const i = v.indexOf(":");
    const source = v.slice(0, i);
    if (source !== "gateway" && source !== "db")
      throw new Error("SOURCE_INVALID");
    return new FileCollector(
      v.slice(i + 1),
      process.env.INGEST_CURSOR_DIR ?? "runtime/cursors",
      source,
    );
  });
while (!stopped) {
  try {
    await db.ready();
    for (const s of sources) await s.spool.drain(db, s.origin);
    for (const f of files) await f.drain(db);
  } catch {
    process.stderr.write("INGEST_UNAVAILABLE: durable source retained.\n");
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
await db.close();
