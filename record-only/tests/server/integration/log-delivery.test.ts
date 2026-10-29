import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Database } from "../../../apps/server/src/database.js";
import { FileCollector } from "../../../apps/server/src/file-collector.js";
import { Spool } from "../../../apps/server/src/storage.js";

it("S-I-09/17: PG 中断保留日志，恢复补传且游标重放不重复入库", async () => {
  const adminUrl =
    process.env.TEST_DATABASE_URL ??
    "postgres://cyez_test:integration-only@127.0.0.1:55432/cyez_test";
  const databaseName = "cyez_logs_" + randomUUID().replaceAll("-", "");
  const root = await mkdtemp(join(tmpdir(), "cyez-log-delivery-"));
  const sourceDir = join(root, "gateway");
  const cursorDir = join(root, "cursors");
  const spool = new Spool(join(root, "api"));
  const admin = new Database(adminUrl);
  let db: Database | undefined;
  try {
    await admin.sequelize.getQueryInterface().createDatabase(databaseName);
    const url = new URL(adminUrl);
    url.pathname = "/" + databaseName;
    db = new Database(url.toString());
    await db.migrator.up();
    await spool.append({
      logId: randomUUID(),
      source: "api",
      level: "error",
      atMs: Date.now(),
      appVersion: "0.1.0",
      code: "API_REQUEST_FAILED",
    });
    const accessPath = join(sourceDir, "access.jsonl");
    await mkdir(sourceDir);
    await writeFile(
      accessPath,
      '{"status":200,"elapsed":"0.01"}\n'.repeat(240),
    );
    const collector = new FileCollector(sourceDir, cursorDir, "gateway");

    await db.close();
    await expect(spool.drain(db, "api")).rejects.toThrow();
    await expect(collector.drain(db)).rejects.toThrow();
    expect((await spool.metrics()).count).toBe(1);
    expect(await readdir(cursorDir)).toHaveLength(0);
    expect((await readFile(accessPath, "utf8")).split("\n")).toHaveLength(241);

    db = new Database(url.toString());
    await db.ready();
    await spool.drain(db, "api");
    expect((await spool.metrics()).count).toBe(0);
    expect(await db.logs.count()).toBe(1);
    await collector.drain(db);
    expect(await db.logs.count()).toBe(201);
    await collector.drain(db);
    expect(await db.logs.count()).toBe(241);

    const [cursorFile] = await readdir(cursorDir);
    expect(cursorFile).toBeDefined();
    await writeFile(join(cursorDir, cursorFile), JSON.stringify({ offset: 0 }));
    await collector.drain(db);
    await collector.drain(db);
    expect(await db.logs.count()).toBe(241);

    await writeFile(accessPath, '{"status":503}', { flag: "a" });
    await collector.drain(db);
    expect(await db.logs.count()).toBe(241);
    await writeFile(accessPath, "\n", { flag: "a" });
    await collector.drain(db);
    expect(await db.logs.count()).toBe(242);
    expect(await readFile(accessPath, "utf8")).toContain('"status":503');
  } finally {
    await db?.close();
    await admin.sequelize.getQueryInterface().dropDatabase(databaseName);
    await admin.close();
    await rm(root, { recursive: true, force: true });
  }
});
