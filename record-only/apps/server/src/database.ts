import {
  DataTypes as D,
  Model,
  Sequelize,
  type ModelStatic,
  type ModelAttributes,
  type QueryInterface,
} from "sequelize";
import { Umzug, SequelizeStorage } from "umzug";
import type { Profile, AppLog } from "@record/protocol";
export interface StudentRow extends Profile {
  id: string;
  hashVersion: string;
  isEnabled: boolean;
  profileRefreshedAt: Date | null;
  version: number;
  seedDigest: string;
}
export interface DeviceRow {
  id: string;
  code: string;
  displayName: string;
  notes: string;
  isDisabled: boolean;
  deletedAt: Date | null;
  version: number;
}
export interface TagRow {
  id: string;
  name: string;
  normalizedName: string;
  version: number;
}
export interface LinkRow {
  deviceId: string;
  tagId: string;
}
export interface UsageRow {
  id: string;
  studentId: string;
  deviceId: string;
  startedAt: Date;
  endedAt: Date | null;
  notes: string;
  endReason: string | null;
  version: number;
  clientId: string;
  createdAt: Date;
  updatedAt: Date;
}
export interface OperationRow {
  id: string;
  clientId: string;
  requestId: string;
  intentId: string | null;
  route: string;
  digest: string;
  result: unknown;
  createdAt: Date;
}
export interface AuditRow {
  id: string;
  actor: string;
  clientId: string;
  requestId: string | null;
  scanId: string | null;
  studentId: string | null;
  recordId: string | null;
  deviceId: string | null;
  action: string;
  fields: string[];
  at: Date;
}
export interface LogRow {
  id: string;
  origin: string;
  logId: string;
  entry: AppLog;
  receivedAt: Date;
}
export interface SettingRow {
  key: string;
  value: string;
}
type Table<T extends object> = ModelStatic<Model<T, T>>;
const pk = () => ({ type: D.UUID, primaryKey: true, allowNull: false });
const str = (length: number, allowNull = false) => ({
  type: D.STRING(length),
  allowNull,
});
const integer = () => ({ type: D.INTEGER, allowNull: false });
const date = (allowNull = false) => ({ type: D.DATE, allowNull });
const fk = (model: string, type = D.UUID) => ({
  type,
  allowNull: false,
  references: { model, key: "id" },
  onDelete: "RESTRICT",
  onUpdate: "RESTRICT",
});
function definitions() {
  return {
    students: {
      id: { ...str(64), primaryKey: true },
      hashVersion: str(40),
      name: str(100),
      className: str(100),
      schoolNumber: str(100),
      isEnabled: { type: D.BOOLEAN, allowNull: false },
      profileRefreshedAt: date(true),
      version: integer(),
      seedDigest: str(64),
    },
    devices: {
      id: pk(),
      code: str(60),
      displayName: str(120),
      notes: { type: D.TEXT, allowNull: false },
      isDisabled: { type: D.BOOLEAN, allowNull: false },
      deletedAt: date(true),
      version: integer(),
    },
    tags: {
      id: pk(),
      name: str(80),
      normalizedName: str(80),
      version: integer(),
    },
    device_tags: {
      deviceId: { ...fk("devices"), primaryKey: true },
      tagId: { ...fk("tags"), primaryKey: true },
    },
    usage_records: {
      id: pk(),
      studentId: fk("students", D.STRING(64) as unknown as typeof D.UUID),
      deviceId: fk("devices"),
      startedAt: date(),
      endedAt: date(true),
      notes: { type: D.TEXT, allowNull: false },
      endReason: str(20, true),
      version: integer(),
      clientId: { type: D.UUID, allowNull: false },
      createdAt: date(),
      updatedAt: date(),
    },
    operations: {
      id: pk(),
      clientId: { type: D.UUID, allowNull: false },
      requestId: { type: D.UUID, allowNull: false },
      intentId: { type: D.UUID, allowNull: true },
      route: str(160),
      digest: str(64),
      result: { type: D.JSONB, allowNull: false },
      createdAt: date(),
    },
    audit_events: {
      id: pk(),
      actor: str(100),
      clientId: { type: D.UUID, allowNull: false },
      requestId: { type: D.UUID, allowNull: true },
      scanId: { type: D.UUID, allowNull: true },
      studentId: {
        ...fk("students", D.STRING(64) as unknown as typeof D.UUID),
        allowNull: true,
      },
      recordId: { ...fk("usage_records"), allowNull: true },
      deviceId: { ...fk("devices"), allowNull: true },
      action: str(60),
      fields: { type: D.JSONB, allowNull: false },
      at: date(),
    },
    app_logs: {
      id: pk(),
      origin: str(120),
      logId: { type: D.UUID, allowNull: false },
      entry: { type: D.JSONB, allowNull: false },
      receivedAt: date(),
    },
    settings: { key: { ...str(80), primaryKey: true }, value: str(256) },
  };
}
export class Database {
  readonly sequelize: Sequelize;
  readonly students: Table<StudentRow>;
  readonly devices: Table<DeviceRow>;
  readonly tags: Table<TagRow>;
  readonly links: Table<LinkRow>;
  readonly records: Table<UsageRow>;
  readonly operations: Table<OperationRow>;
  readonly audits: Table<AuditRow>;
  readonly logs: Table<LogRow>;
  readonly settings: Table<SettingRow>;
  readonly migrator: Umzug<QueryInterface>;
  constructor(url: string) {
    this.sequelize = new Sequelize(url, {
      logging: false,
      logQueryParameters: false,
      pool: { max: 12, min: 0, acquire: 10000 },
      retry: { max: 0 },
      define: { timestamps: false, freezeTableName: true },
    });
    const defs = definitions();
    const define = <T extends object>(name: keyof typeof defs): Table<T> =>
      this.sequelize.define(name, defs[name] as ModelAttributes) as Table<T>;
    this.students = define("students");
    this.devices = define("devices");
    this.tags = define("tags");
    this.links = define("device_tags");
    this.records = define("usage_records");
    this.operations = define("operations");
    this.audits = define("audit_events");
    this.logs = define("app_logs");
    this.settings = define("settings");
    this.migrator = new Umzug({
      context: this.sequelize.getQueryInterface(),
      storage: new SequelizeStorage({ sequelize: this.sequelize }),
      logger: undefined,
      migrations: [
        {
          name: "001-initial",
          up: async () => {
            await this.sequelize.transaction(async (transaction) => {
              const q = this.sequelize.getQueryInterface();
              for (const [name, attributes] of Object.entries(defs))
                await q.createTable(name, attributes, { transaction });
              await q.addIndex("devices", ["code"], {
                unique: true,
                transaction,
              });
              await q.addIndex("tags", ["normalizedName"], {
                unique: true,
                transaction,
              });
              await q.addIndex("device_tags", ["tagId", "deviceId"], {
                transaction,
              });
              for (const key of ["studentId", "deviceId"]) {
                await q.addIndex("usage_records", [key], {
                  name: `active_${key}`,
                  unique: true,
                  where: { endedAt: null },
                  transaction,
                });
                await q.addIndex(
                  "usage_records",
                  [key, "startedAt", "endedAt"],
                  { transaction },
                );
              }
              await q.addIndex("usage_records", ["endedAt", "id"], {
                transaction,
              });
              await q.addIndex("operations", ["clientId", "requestId"], {
                unique: true,
                transaction,
              });
              await q.addIndex("operations", ["intentId"], {
                unique: true,
                transaction,
              });
              await q.addIndex("app_logs", ["origin", "logId"], {
                unique: true,
                transaction,
              });
            });
          },
        },
      ],
    });
  }
  async ready() {
    await this.sequelize.authenticate();
    const metadata =
      this.sequelize.models.SchemaReadiness ??
      this.sequelize.define(
        "SchemaReadiness",
        { name: { type: D.STRING, primaryKey: true } },
        { tableName: "SequelizeMeta", timestamps: false },
      );
    const completed = await metadata.findAll();
    if (!completed.some((row) => row.get("name") === "001-initial"))
      throw new Error("SCHEMA_NOT_READY");
  }
  async close() {
    await this.sequelize.close();
  }
}
