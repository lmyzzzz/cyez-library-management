import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "./database.js";
import { ingestLogs } from "./storage.js";
import type { AppLog } from "@record/protocol";
/** Byte-offset cursors are advanced only after PG commits. Source files are never
 * automatically removed: retention remains TBD-05. Replays have deterministic IDs.
 * A cursor also carries a generation so that lines written after truncation or
 * rotation get fresh deterministic IDs instead of colliding with old rows. */
interface Cursor {
  offset: number;
  generation: number;
  /** Inode of the source file when the cursor was written, when available. */
  ino?: number;
}
function parseCursor(raw: string): Cursor | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const fields = value as Record<string, unknown>;
  const offset = fields.offset;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
    return undefined;
  // Legacy cursors (offset only) are valid and map to generation zero so their
  // replay IDs stay identical to the rows written before this change.
  const generation = fields.generation === undefined ? 0 : fields.generation;
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  )
    return undefined;
  const ino = fields.ino;
  if (
    ino !== undefined &&
    (typeof ino !== "number" || !Number.isSafeInteger(ino) || ino < 0)
  )
    return undefined;
  return { offset, generation, ino };
}
function resetGeneration(raw: string): number {
  // Salvage the previous generation when only another field was malformed so
  // the recovered IDs stay distinct from the rows already committed for this
  // file; fall back to a fixed fresh generation for unparseable cursors.
  try {
    const value = JSON.parse(raw) as { generation?: unknown };
    const generation = value?.generation;
    if (
      typeof generation === "number" &&
      Number.isSafeInteger(generation) &&
      generation >= 0
    )
      return generation + 1;
  } catch {
    /* Not JSON: use the default fresh generation. */
  }
  return 1;
}
let lastCorruptStamp = 0;
function corruptStamp() {
  // Keep `<name>.corrupt-<timestamp>` unique even when several corrupt files
  // appear within the same millisecond.
  lastCorruptStamp = Math.max(Date.now(), lastCorruptStamp + 1);
  return lastCorruptStamp;
}
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
  private async readCursor(
    path: string,
  ): Promise<{ cursor: Cursor; reset: boolean }> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { cursor: { offset: 0, generation: 0 }, reset: false };
      throw error;
    }
    const cursor = parseCursor(raw);
    if (cursor) return { cursor, reset: false };
    // A malformed cursor must not wedge this source forever. Move it aside for
    // inspection and resume from the start under a fresh generation; source
    // data is never deleted here.
    await rename(path, `${path}.corrupt-${corruptStamp()}`).catch(() => {});
    return {
      cursor: { offset: 0, generation: resetGeneration(raw) },
      reset: true,
    };
  }
  private async writeCursor(path: string, cursor: Cursor) {
    const temp = `${path}.${randomUUID()}.tmp`;
    let f: Awaited<ReturnType<typeof open>> | undefined;
    try {
      f = await open(temp, "wx");
      await f.writeFile(JSON.stringify(cursor));
      await f.sync();
      await f.close();
      f = undefined;
      await rename(temp, path);
    } catch (error) {
      if (f) await f.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
  async drain(db: Database) {
    await mkdir(this.cursors, { recursive: true });
    const files = (await readdir(this.directory))
      .filter((f) => /\.(json|jsonl|log)$/.test(f))
      .sort();
    for (const name of files) {
      const path = join(this.directory, name),
        cursorPath = join(this.cursors, `${this.source}-${this.id(name)}.json`);
      const handle = await open(path, "r");
      try {
        const info = await handle.stat();
        const { cursor, reset: cursorReset } =
          await this.readCursor(cursorPath);
        let offset = cursor.offset,
          generation = cursor.generation,
          reset = cursorReset;
        // A shorter file means truncation/copytruncate; a different inode means
        // the file was rotated (possibly to one that is already larger). Neither
        // is fatal: restart at zero under a new generation so later lines are
        // not suppressed by old (origin, logId) rows.
        if (
          info.size < offset ||
          (cursor.ino !== undefined && info.ino !== cursor.ino)
        ) {
          offset = 0;
          generation += 1;
          reset = true;
        }
        if (info.size === offset) {
          // Persist a reset even when there is nothing to read yet so a later
          // append cannot fall back to an older generation.
          if (reset)
            await this.writeCursor(cursorPath, {
              offset,
              generation,
              ino: info.ino,
            });
          continue;
        }
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
                logId: this.id(`${name}:${generation}:${lineStart}:${end}`),
                source: this.source,
                level: "info",
                atMs: Math.max(0, Math.floor(info.mtimeMs)),
                appVersion: "0.1.0",
                code:
                  this.source === "gateway"
                    ? "GATEWAY_ACCESS"
                    : "DATABASE_EVENT",
              });
              committed = end;
              lineStart = end;
              if (logs.length >= 200) break;
            }
            position += read.bytesRead;
          }
        } finally {
          buffer.fill(0);
        }
        if (!logs.length) {
          if (reset)
            await this.writeCursor(cursorPath, {
              offset: committed,
              generation,
              ino: info.ino,
            });
          continue;
        }
        await ingestLogs(db, this.source, logs);
        await this.writeCursor(cursorPath, {
          offset: committed,
          generation,
          ino: info.ino,
        });
      } finally {
        await handle.close();
      }
    }
  }
}
