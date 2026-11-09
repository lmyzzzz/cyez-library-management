import {
  mkdir,
  open,
  rename,
  readdir,
  readFile,
  unlink,
  stat,
  statfs,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ApiError,
  logSchema,
  type AppLog,
  type Action,
  type ServiceStatus,
} from "@record/protocol";
import type { Config } from "./config.js";
import type { Database } from "./database.js";
/** `.json` is the committed, drainable name. Appends are staged in a unique
 * `.tmp` file that is never scanned and atomically renamed into place. Legacy
 * `.pending` files from the previous writer are delivered (or quarantined) once
 * after the new writer can no longer produce them. */
const committed = (name: string) => name.endsWith(".json");
const pending = (name: string) => name.endsWith(".pending");
let lastCorruptStamp = 0;
function corruptStamp() {
  // Keep `<name>.corrupt-<timestamp>` unique even when several corrupt files
  // appear within the same millisecond.
  lastCorruptStamp = Math.max(Date.now(), lastCorruptStamp + 1);
  return lastCorruptStamp;
}
export class Spool {
  constructor(readonly directory: string) {}
  async init() {
    await mkdir(this.directory, { recursive: true });
  }
  async append(log: AppLog) {
    const clean = logSchema.parse(log);
    await this.init();
    const destination = join(this.directory, `${clean.logId}.json`);
    // Unique temp names keep concurrent appends from unlinking each other's file.
    const tmp = join(this.directory, `${clean.logId}.json.${randomUUID()}.tmp`);
    let f: Awaited<ReturnType<typeof open>> | undefined;
    try {
      f = await open(tmp, "wx");
      await f.writeFile(JSON.stringify(clean));
      await f.sync();
      await f.close();
      f = undefined;
      await rename(tmp, destination);
    } catch (error) {
      if (f) await f.close().catch(() => {});
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }
  async metrics() {
    await this.init();
    const files = (await readdir(this.directory)).filter(
      (n) => committed(n) || pending(n),
    );
    let bytes = 0,
      oldest = Date.now();
    for (const n of files) {
      const s = await stat(join(this.directory, n));
      bytes += s.size;
      oldest = Math.min(oldest, s.mtimeMs);
    }
    return { count: files.length, bytes, oldestAgeMs: Date.now() - oldest };
  }
  private async quarantine(name: string) {
    const source = join(this.directory, name);
    const target = join(this.directory, `${name}.corrupt-${corruptStamp()}`);
    try {
      // The corrupt payload is retained for inspection but removed from the
      // drainable namespace so one bad entry cannot wedge all later logs.
      await rename(source, target);
    } catch {
      /* Best effort: an unrenameable file stays out of the way of other drains. */
    }
  }
  private async deliver(db: Database, origin: string, name: string) {
    const path = join(this.directory, name);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      // Transient I/O failures keep the committed file for a later retry.
      throw error;
    }
    let log: AppLog;
    try {
      log = logSchema.parse(JSON.parse(raw));
    } catch {
      await this.quarantine(name);
      return;
    }
    // Ingest failures intentionally propagate: the committed file is retained
    // and replayed later, and (origin, logId) deduplication keeps that safe.
    await ingestLogs(db, origin, [log]);
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  async drain(db: Database, origin: string) {
    await this.init();
    const names = (await readdir(this.directory)).sort();
    for (const n of names) if (committed(n)) await this.deliver(db, origin, n);
    // Legacy `.pending` files (old writer naming); new appends never create them
    // and use an unscanned `.tmp` stage, so this cannot race a current write.
    for (const n of names) if (pending(n)) await this.deliver(db, origin, n);
  }
}
export async function ingestLogs(db: Database, origin: string, logs: AppLog[]) {
  await db.sequelize.transaction(async (transaction) => {
    await db.logs.bulkCreate(
      logs.map((entry) => ({
        id: randomUUID(),
        origin,
        logId: entry.logId,
        entry: logSchema.parse(entry),
        receivedAt: new Date(),
      })),
      { ignoreDuplicates: true, transaction },
    );
  });
  return { acked: logs.map((l) => l.logId) };
}
export interface StorageProbe {
  freeBytes: number;
  writable: boolean;
  oldestAgeMs: number;
}
export class Capacity {
  private mode: ServiceStatus["mode"] = "normal";
  constructor(
    private config: Config,
    private spool: Spool,
    private probe?: () => Promise<StorageProbe>,
  ) {}
  async status(): Promise<ServiceStatus> {
    let p: StorageProbe;
    try {
      p = await (this.probe?.() ?? this.inspect());
    } catch {
      p = { freeBytes: 0, writable: false, oldestAgeMs: 0 };
    }
    const c = this.config.capacity;
    if (!p.writable) this.mode = "failed";
    else if (p.freeBytes <= c.reserveBytes) this.mode = "restricted";
    else if (
      (this.mode === "restricted" || this.mode === "failed") &&
      p.freeBytes < c.recoveryBytes
    )
      this.mode = "restricted";
    else if (p.freeBytes <= c.warningBytes || p.oldestAgeMs >= c.oldestWarnMs)
      this.mode = "warning";
    else if (p.freeBytes >= c.recoveryBytes) this.mode = "normal";
    const allowedActions: Action[] =
      this.mode === "failed"
        ? ["read"]
        : this.mode === "restricted"
          ? ["read", "end"]
          : ["read", "scan", "start", "end", "modify"];
    return {
      mode: this.mode,
      allowedActions,
      reasonCodes:
        this.mode === "normal" ? [] : [`STORAGE_${this.mode.toUpperCase()}`],
      environment: this.config.environment,
    };
  }
  async require(action: Action) {
    if (!(await this.status()).allowedActions.includes(action))
      throw new ApiError("STORAGE_WRITE_RESTRICTED", 503);
  }
  private async inspect(): Promise<StorageProbe> {
    await this.spool.init();
    const paths = [
      this.spool.directory,
      ...(process.env.CAPACITY_PATHS?.split(";").filter(Boolean) ?? []),
    ];
    let freeBytes = Infinity;
    for (const path of paths) {
      const fs = await statfs(path);
      freeBytes = Math.min(freeBytes, fs.bavail * fs.bsize);
    }
    // A real fsync probe detects read-only media independently of free-space counters.
    const file = join(this.spool.directory, `.probe-${randomUUID()}`);
    const f = await open(file, "wx");
    try {
      await f.write("1");
      await f.sync();
    } finally {
      await f.close();
      await unlink(file);
    }
    return {
      freeBytes,
      writable: true,
      oldestAgeMs: (await this.spool.metrics()).oldestAgeMs,
    };
  }
}
