import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, open, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "./database.js";
import { ingestLogs } from "./storage.js";
import type { AppLog } from "@record/protocol";
/** Byte-offset cursors are advanced only after PG commits. Source files are never
 * automatically removed: retention remains TBD-05. Replays have deterministic IDs. */
export class FileCollector {
  constructor(
    private directory: string,
    private cursors: string,
    private source: "gateway" | "db",
  ) {}
  private id(value: string) {
    const h = createHash("sha256").update(value).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
  async drain(db: Database) {
    await mkdir(this.cursors, { recursive: true });
    const files = (await readdir(this.directory))
      .filter((f) => /\.(json|jsonl|log)$/.test(f))
      .sort();
    for (const name of files) {
      const path = join(this.directory, name),
        cursorPath = join(this.cursors, `${this.source}-${this.id(name)}.json`);
      let offset = 0;
      try {
        offset = JSON.parse(await readFile(cursorPath, "utf8")).offset;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error("CURSOR_INVALID");
      }
      const info = await stat(path);
      if (info.size < offset) throw new Error("UNEXPECTED_LOG_TRUNCATION");
      if (info.size === offset) continue;
      const handle = await open(path, "r");
      let committed = offset,
        lineStart = offset,
        position = offset;
      const logs: AppLog[] = [];
      const buffer = Buffer.alloc(65536);
      try {
        while (position < info.size && logs.length < 200) {
          const read = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, info.size - position),
            position,
          );
          if (!read.bytesRead) break;
          for (let i = 0; i < read.bytesRead; i++) {
            if (buffer[i] !== 10) continue;
            const end = position + i + 1;
            logs.push({
              logId: this.id(`${name}:${lineStart}:${end}`),
              source: this.source,
              level: "info",
              atMs: Math.max(0, Math.floor(info.mtimeMs)),
              appVersion: "0.1.0",
              code:
                this.source === "gateway" ? "GATEWAY_ACCESS" : "DATABASE_EVENT",
            });
            committed = end;
            lineStart = end;
            if (logs.length >= 200) break;
          }
          position += read.bytesRead;
        }
      } finally {
        buffer.fill(0);
        await handle.close();
      }
      if (!logs.length) continue;
      await ingestLogs(db, this.source, logs);
      const temp = cursorPath + ".pending";
      const cursor = await open(temp, "w");
      try {
        await cursor.writeFile(JSON.stringify({ offset: committed }));
        await cursor.sync();
      } finally {
        await cursor.close();
      }
      await rename(temp, cursorPath);
    }
  }
}
