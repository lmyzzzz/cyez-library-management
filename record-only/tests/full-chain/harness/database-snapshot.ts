import type {
  StudentRow,
  UsageRow,
  LogRow,
  OperationRow,
  AuditRow,
  SettingRow,
} from "../../../apps/server/src/database.js";

export interface DatabaseSnapshot {
  students: StudentRow[];
  records: UsageRow[];
  logs: LogRow[];
  operations: OperationRow[];
  audits: AuditRow[];
  settings: SettingRow[];
  migrations: string[];
  roles: string[];
  privileges: {
    audit_select: boolean;
    logs_select: boolean;
    students_insert: boolean;
  };
}

// The fixture runs with the migration owner inside an isolated test deployment.
// All business writes go through HTTPS; this observer only uses ORM reads.
export function snapshotScript(
  databaseModule: string,
  ownerUrl: string,
  runtimeRole: string,
) {
  return `
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(databaseModule)});
const { DataTypes, fn } = require('sequelize');
const { Database } = await import(${JSON.stringify(databaseModule)});
const db = new Database(${ownerUrl});
try {
  const result = {};
  for (const key of ['students','records','logs','operations','audits','settings'])
    result[key] = await db[key].findAll({ raw: true });
  result.migrations = (await db.migrator.executed()).map(x => x.name);
  const roles = db.sequelize.define('role_migrations', { name: { type: DataTypes.STRING, primaryKey: true } });
  result.roles = (await roles.findAll({ attributes: ['name'], order: [['name','ASC']], raw: true })).map(x => x.name);
  result.privileges = await db.settings.findOne({ where: { key: 'identity' }, raw: true, attributes: [
    [fn('has_table_privilege', ${JSON.stringify(runtimeRole)}, 'audit_events', 'SELECT'), 'audit_select'],
    [fn('has_table_privilege', ${JSON.stringify(runtimeRole)}, 'app_logs', 'SELECT'), 'logs_select'],
    [fn('has_table_privilege', ${JSON.stringify(runtimeRole)}, 'students', 'INSERT'), 'students_insert']
  ] });
  process.stdout.write(JSON.stringify(result));
} finally { await db.sequelize.close(); }
`;
}
