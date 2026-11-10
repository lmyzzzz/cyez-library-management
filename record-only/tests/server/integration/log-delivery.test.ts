import { createHash, randomUUID } from "node:crypto";
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
import { ingestLogs, Spool } from "../../../apps/server/src/storage.js";

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
    // Simulate a pre-upgrade commit whose cursor ACK was lost. Generation zero
    // must retain the old name:start:end ID rather than inserting it twice.
    const firstEnd = Buffer.byteLength('{"status":200,"elapsed":"0.01"}\n');
    const h = createHash("sha256")
      .update(`access.jsonl:0:${firstEnd}`)
      .digest("hex");
    await ingestLogs(db, "gateway", [
      {
        logId: `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`,
        source: "gateway",
        level: "info",
        atMs: Date.now(),
        appVersion: "0.1.0",
        code: "GATEWAY_ACCESS",
      },
    ]);
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

    // Truncation/rotation must not throw or let old deterministic rows suppress
    // lines written at reused offsets; continue under a new cursor generation.
    await writeFile(accessPath, '{"status":200,"rotated":1}\n');
    await collector.drain(db);
    expect(await db.logs.count()).toBe(243);
    const rotatedCursor = JSON.parse(
      await readFile(join(cursorDir, cursorFile), "utf8"),
    ) as { offset: number; generation: number };
    expect(rotatedCursor.generation).toBe(1);
    expect(rotatedCursor.offset).toBe(
      Buffer.byteLength('{"status":200,"rotated":1}\n'),
    );
    await collector.drain(db);
    expect(await db.logs.count()).toBe(243);
    // Corrupt cursor + database outage: the new generation must be durably
    // selected before ingestion so a restart cannot revert to generation zero.
    await writeFile(join(cursorDir, cursorFile), "{broken");
    await db.close();
    await expect(collector.drain(db)).rejects.toThrow();
    const reset = JSON.parse(
      await readFile(join(cursorDir, cursorFile), "utf8"),
    );
    expect(reset.offset).toBe(0);
    expect(reset.generation).toBeGreaterThan(1);
    db = new Database(url.toString());
    await new FileCollector(sourceDir, cursorDir, "gateway").drain(db);
    expect(await db.logs.count()).toBe(244);
    await collector.drain(db);
    expect(await db.logs.count()).toBe(244);
  } finally {
    await db?.close();
    await admin.sequelize.getQueryInterface().dropDatabase(databaseName);
    await admin.close();
    await rm(root, { recursive: true, force: true });
  }
});
