import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { payloadDigest } from "@record/domain";
import { loadConnection } from "../harness/connection.js";
import { DockerStack, createStack, sleep, waitFor } from "../harness/stack.js";
import { FullChainClient, mustBe } from "../harness/api.js";
import {
  count,
  psqlValue,
  uid,
  uniqueCode,
  waitForFiles,
  waitForLogIngest,
} from "./support.js";

const connection = await loadConnection();
const stack = await createStack(connection);
let client: FullChainClient;

interface PreviewBody {
  id: string;
  mode: "start" | "end";
}
interface RecordBody {
  recordId: string;
  version: number;
}

beforeAll(async () => {
  client = new FullChainClient(connection);
  await client.reauthenticate();
});

describe("全链路：日志归集、持久化与故障恢复", () => {
  it("S-I-09/17: api、gateway、db 三类来源归集入库，停机期间 spool 保留", async () => {
    await stack.stop("log-ingest");
    try {
      // A provider outage produces an API error log entry on the durable spool.
      const outage = await client.scan("eeeeeeee");
      expect(outage.status).toBe(503);
      const spoolFiles = await waitForFiles(stack, "api", "/data/api-spool");
      expect(spoolFiles.length).toBeGreaterThan(0);
      const spool = await stack.readDirectory("api", "/data/api-spool");
      expect(spool).toContain("API_REQUEST_FAILED");
      expect(spool).not.toContain("eeeeeeee");

      // Gateway and database logs are file sources; they must exist independently.
      const gatewayLogs = await stack.listFiles("gateway", "/var/log/cyez");
      expect(gatewayLogs).toContain("access.jsonl");
      if (connection.mode === "docker") {
        const dbLogs = await stack.listFiles("db", "/var/log/cyez");
        expect(dbLogs.some((name) => name.startsWith("db-"))).toBe(true);
      }
    } finally {
      await stack.start("log-ingest");
    }

    const counts = await waitForLogIngest(
      stack,
      (current) =>
        (current.api ?? 0) > 0 &&
        (current.gateway ?? 0) > 0 &&
        (connection.mode === "local" || (current.db ?? 0) > 0),
    );
    expect(counts.api).toBeGreaterThan(0);
    expect(counts.gateway).toBeGreaterThan(0);
    if (connection.mode === "docker") expect(counts.db).toBeGreaterThan(0);

    // Replaying the same file offsets must not duplicate persisted logIds.
    const beforeRestart = await count(stack, "SELECT count(*) FROM app_logs");
    await stack.restart("log-ingest");
    await sleep(2500);
    const afterRestart = await count(stack, "SELECT count(*) FROM app_logs");
    expect(afterRestart).toBeGreaterThanOrEqual(beforeRestart);
    expect(
      await count(
        stack,
        'SELECT count(*) FROM (SELECT "logId" FROM app_logs GROUP BY "logId" HAVING count(*) > 1) duplicated',
      ),
    ).toBe(0);
  });

  it("S-I-09: 客户端日志跨 log-ingest 重启补传且按稳定 ID 去重", async () => {
    const logId = randomUUID();
    const log = {
      logId,
      source: "main" as const,
      level: "info" as const,
      atMs: Date.now(),
      appVersion: "0.1.0",
      code: "DISCONNECTED" as const,
    };
    mustBe(await client.logsBatch([log]), 200, "client log batch");
    await stack.restart("log-ingest");
    mustBe(await client.logsBatch([log]), 200, "client log replay");
    await waitFor("client log ingested once", async () => {
      const rows = await stack.rows(
        `SELECT count(*) FROM app_logs WHERE "logId" = '${logId}'`,
      );
      return Number(rows[0][0]) === 1;
    });
  });

  it.skipIf(connection.mode === "local" && !connection.local?.dbControl)(
    "S-I-10: DB 停机时 readiness 为 503，恢复后 200 且数据与操作可用",
    async () => {
      const device = (
        mustBe(
          await client.createDevice({ code: uniqueCode("FC-DB-RESTART") }),
          200,
          "create device",
        ).json as { deviceId: string }
      ).deviceId;
      const scan = mustBe(await client.scan(uid("db-restart")), 200, "scan")
        .json as PreviewBody;
      const started = mustBe(
        await client.start(scan.id, device, { notes: "DB 重启前登记" }),
        200,
        "start",
      ).json as RecordBody;
      mustBe(
        await client.endWithPreview(started.recordId, {
          notes: "DB 重启前结束",
        }),
        200,
        "end",
      );
      const historyBefore = await count(
        stack,
        "SELECT count(*) FROM usage_records",
      );
      const studentsBefore = await count(
        stack,
        "SELECT count(*) FROM students",
      );

      await stack.stop("db");
      try {
        await waitFor(
          "gateway readiness reports 503 while the database is stopped",
          async () => {
            try {
              return (await stack.gateway.healthReady()).status === 503;
            } catch {
              return false;
            }
          },
          { timeoutMs: 90_000, intervalMs: 1000 },
        );
        // The API process itself is alive and read-only status stays available.
        expect((await stack.gateway.healthLive()).status).toBe(200);
        mustBe(await client.serviceStatus(), 200, "status during DB outage");
        const states = await stack.composePs();
        const ingest = states.find((state) => state.Service === "log-ingest");
        expect(ingest?.State).toBe("running");
      } finally {
        await stack.start("db");
      }

      const ready = await stack.gateway.healthReady();
      expect(ready.status).toBe(200);
      expect(await count(stack, "SELECT count(*) FROM usage_records")).toBe(
        historyBefore,
      );
      expect(await count(stack, "SELECT count(*) FROM students")).toBe(
        studentsBefore,
      );
      // The in-memory session survived the database restart.
      const history = mustBe(
        await client.records({ state: "ended" }),
        200,
        "history after DB restart",
      );
      expect(
        (history.json as { items: Array<{ id: string }> }).items.map(
          (item) => item.id,
        ),
      ).toContain(started.recordId);
      // New writes work again.
      const recoveryScan = await client.scan(uid("db-restart-after"));
      mustBe(recoveryScan, 200, "scan after DB recovery");
    },
  );

  it("S-I-10: down/up 保留命名卷数据，不删除卷可恢复历史和缓存", async () => {
    const recordsBefore = await count(
      stack,
      "SELECT count(*) FROM usage_records",
    );
    const studentsBefore = await count(stack, "SELECT count(*) FROM students");
    const logsBefore = await count(stack, "SELECT count(*) FROM app_logs");
    const oldToken = client.token;

    await stack.restartProject();

    expect(
      (
        await client.request("GET", "/service-status", undefined, {
          token: oldToken,
        })
      ).status,
    ).toBe(401);
    await client.reauthenticate();
    expect(await count(stack, "SELECT count(*) FROM usage_records")).toBe(
      recordsBefore,
    );
    expect(await count(stack, "SELECT count(*) FROM students")).toBe(
      studentsBefore,
    );
    expect(
      await count(stack, "SELECT count(*) FROM app_logs"),
    ).toBeGreaterThanOrEqual(logsBefore);
    const history = mustBe(
      await client.records({ state: "ended", pageSize: 1 }),
      200,
      "history after down/up",
    );
    expect((history.json as { total: number }).total).toBeGreaterThan(0);

    if (connection.mode === "docker") {
      const dockerStack = stack as DockerStack;
      const prefix = `cyez-fc-${connection.runId}`;
      const volumes = await dockerStack.runner.docker(
        ["volume", "ls", "-q", "--filter", `name=${prefix}`],
        { timeoutMs: 30_000 },
      );
      const names = volumes.stdout
        .replace(/\r\n/g, "\n")
        .split("\n")
        .filter(Boolean);
      for (const volume of [
        `${prefix}-pgdata`,
        `${prefix}-api-spool`,
        `${prefix}-gateway-spool`,
        `${prefix}-db-spool`,
        `${prefix}-ingest-cursors`,
      ])
        expect(names, volume).toContain(volume);
    }
  });

  it("S-I-10: schema、角色迁移与身份指纹一致", async () => {
    const fingerprint = await psqlValue(
      stack,
      "SELECT value FROM settings WHERE key = 'identity'",
    );
    expect(fingerprint).toBe(payloadDigest("identity", connection.identity));
    const roles = await stack.rows(
      "SELECT name FROM role_migrations ORDER BY name",
    );
    expect(roles.map((row) => row[0])).toEqual([
      "001-runtime-role",
      "002-student-cache-insert",
      "003-provider-config",
    ]);
    const runtimeRole = connection.local?.runtimeRole ?? "cyez_runtime";
    const runtime = await stack.rows(
      `SELECT CASE WHEN has_table_privilege('${runtimeRole}', 'audit_events', 'SELECT') THEN 't' ELSE 'f' END AS audit_select,
              CASE WHEN has_table_privilege('${runtimeRole}', 'app_logs', 'SELECT') THEN 't' ELSE 'f' END AS logs_select,
              CASE WHEN has_table_privilege('${runtimeRole}', 'students', 'INSERT') THEN 't' ELSE 'f' END AS students_insert`,
    );
    expect(runtime[0]).toEqual(["f", "t", "t"]);
  });
});
