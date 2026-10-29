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
export class Spool {
  constructor(readonly directory: string) {}
  async init() {
    await mkdir(this.directory, { recursive: true });
  }
  async append(log: AppLog) {
    const clean = logSchema.parse(log);
    await this.init();
    const destination = join(this.directory, `${clean.logId}.json`);
    const tmp = destination + ".pending";
    const f = await open(tmp, "wx");
    try {
      await f.writeFile(JSON.stringify(clean));
      await f.sync();
    } finally {
      await f.close();
    }
    await rename(tmp, destination);
  }
  async metrics() {
    await this.init();
    const files = (await readdir(this.directory)).filter(
      (n) => n.endsWith(".json") || n.endsWith(".pending"),
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
  async drain(db: Database, origin: string) {
    await this.init();
    for (const n of (await readdir(this.directory))
      .filter((n) => n.endsWith(".json") || n.endsWith(".pending"))
      .sort()) {
      const path = join(this.directory, n);
      let log: AppLog;
      try {
        log = logSchema.parse(JSON.parse(await readFile(path, "utf8")));
      } catch {
        throw new ApiError("SPOOL_CORRUPT", 503);
      }
      await ingestLogs(db, origin, [log]);
      await unlink(path);
    }
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
