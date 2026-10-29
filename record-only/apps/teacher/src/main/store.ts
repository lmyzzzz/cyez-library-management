import { Sequelize, DataTypes as D, Model, type ModelStatic } from "sequelize";
import { mkdir, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ApiError, logSchema, type AppLog } from "@record/protocol";
type Intent = {
  requestId: string;
  origin: string;
  method: string;
  path: string;
  body: Record<string, unknown>;
  createdAt: number;
  state: string;
};
type Setting = { key: string; value: string };
type Log = { logId: string; entry: AppLog; atMs: number };
type Table<T extends object> = ModelStatic<Model<T, T>>;
export class LocalStore {
  readonly db: Sequelize;
  readonly intents: Table<Intent>;
  readonly settings: Table<Setting>;
  readonly logs: Table<Log>;
  failed = false;
  constructor(readonly filename: string) {
    this.db = new Sequelize({
      dialect: "sqlite",
      storage: filename,
      logging: false,
      define: { timestamps: false },
      pool: { max: 1, min: 1 },
    });
    this.intents = this.db.define("intents", {
      requestId: { type: D.STRING, primaryKey: true },
      origin: { type: D.STRING, allowNull: false },
      method: { type: D.STRING, allowNull: false },
      path: { type: D.STRING, allowNull: false },
      body: { type: D.JSON, allowNull: false },
      createdAt: { type: D.BIGINT, allowNull: false },
      state: { type: D.STRING, allowNull: false },
    }) as Table<Intent>;
    this.settings = this.db.define("settings", {
      key: { type: D.STRING, primaryKey: true },
      value: { type: D.TEXT, allowNull: false },
    }) as Table<Setting>;
    this.logs = this.db.define("logs", {
      logId: { type: D.STRING, primaryKey: true },
      entry: { type: D.JSON, allowNull: false },
      atMs: { type: D.BIGINT, allowNull: false },
    }) as Table<Log>;
  }
  async init() {
    await mkdir(dirname(this.filename), { recursive: true });
    const q = this.db.getQueryInterface();
    const existing = await q.showAllTables();
    for (const model of [
      this.settings,
      this.logs,
      this.intents,
    ] as ModelStatic<Model>[])
      if (!existing.includes(model.tableName))
        await q.createTable(model.tableName, model.getAttributes());
  }
  async write<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      this.failed = false;
      return result;
    } catch {
      this.failed = true;
      throw new ApiError("LOCAL_STORAGE_FAILED", 503);
    }
  }
  async get(key: string) {
    return (await this.settings.findByPk(key))?.get().value ?? null;
  }
  async set(key: string, value: string) {
    return this.write(() => this.settings.upsert({ key, value }));
  }
  async clientId() {
    let id = await this.get("clientId");
    if (!id) {
      id = randomUUID();
      await this.set("clientId", id);
    }
    return id;
  }
  async saveIntent(intent: Intent) {
    // Only specific command bodies built by the coordinator enter persistence.
    const forbidden = new Set([
      "card",
      "uidHex",
      "studentId",
      "hashVersion",
      "password",
      "token",
    ]);
    const inspect = (value: unknown): boolean =>
      !!value &&
      typeof value === "object" &&
      Object.entries(value).some(
        ([key, v]) => forbidden.has(key) || inspect(v),
      );
    if (inspect(intent.body) || intent.path.includes("scan-previews"))
      throw new ApiError("PERSISTENCE_BOUNDARY_VIOLATION", 422);
    await this.write(() => this.intents.create(intent));
  }
  async append(entry: AppLog) {
    const clean = logSchema.parse(entry);
    await this.write(() =>
      this.logs.create({ logId: clean.logId, entry: clean, atMs: clean.atMs }),
    );
  }
  async pending(origin: string) {
    return (
      await this.intents.findAll({
        where: { origin, state: "pending" },
        order: [["createdAt", "ASC"]],
      })
    ).map((r) => r.get());
  }
  async logBatch() {
    return (
      await this.logs.findAll({ limit: 100, order: [["atMs", "ASC"]] })
    ).map((r) => r.get().entry);
  }
  async ack(ids: string[]) {
    for (const logId of ids)
      await this.write(() => this.logs.destroy({ where: { logId } }));
  }
  async metrics() {
    const oldest = await this.logs.findOne({ order: [["atMs", "ASC"]] });
    let storage: "normal" | "warning" | "failed" = this.failed
      ? "failed"
      : "normal";
    try {
      const fs = await statfs(dirname(this.filename));
      if (fs.bavail * fs.bsize < 128 * 1024 * 1024 && storage !== "failed")
        storage = "warning";
    } catch {
      storage = "failed";
    }
    return {
      pendingLogs: await this.logs.count(),
      pendingCommands: await this.intents.count({
        where: { state: "pending" },
      }),
      oldestLogAgeMs: oldest ? Date.now() - Number(oldest.get().atMs) : 0,
      storage,
    };
  }
  async close() {
    await this.db.close();
  }
}
