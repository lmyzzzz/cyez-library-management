import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConnection } from "../harness/connection.js";
import { createStack } from "../harness/stack.js";
import {
  FullChainClient,
  mustBe,
  reportCode,
  type GatewayResponse,
} from "../harness/api.js";
import { uid, uniqueCode } from "./support.js";

const connection = await loadConnection();
const stack = await createStack(connection);
let client: FullChainClient;

interface PreviewBody {
  id: string;
  mode: "start" | "end";
  student: { id: string; name: string };
}
interface RecordBody {
  recordId: string;
  version: number;
}
interface PageBody {
  items: Array<{ id: string; notes: string }>;
  total: number;
}

beforeAll(async () => {
  client = new FullChainClient(connection);
  await client.reauthenticate();
});

describe("全链路：重启、幂等与共享口令变更", () => {
  it("S-I-03: API 重启后原 requestId 可查询且不重复执行", async () => {
    const device = (
      mustBe(
        await client.createDevice({ code: uniqueCode("FC-RESTART") }),
        200,
        "create device",
      ).json as { deviceId: string }
    ).deviceId;
    const scan = mustBe(await client.scan(uid("restart-op")), 200, "scan")
      .json as PreviewBody;
    const requestId = randomUUID();
    const started = mustBe(
      await client.start(scan.id, device, {
        requestId,
        notes: "重启前提交",
      }),
      200,
      "start before restart",
    ).json as RecordBody;

    const oldToken = client.token;
    await stack.restart("api");

    const stale = await client.request("GET", "/service-status", undefined, {
      token: oldToken,
    });
    expect(stale.status).toBe(401);
    expect(reportCode(stale)).toBe("AUTH_REQUIRED");

    await client.reauthenticate();
    const operation = mustBe(
      await client.operation(requestId),
      200,
      "operation lookup",
    );
    expect(operation.json).toEqual({
      committed: true,
      result: { recordId: started.recordId, version: 1 },
    });

    const replay = await client.start(scan.id, device, {
      requestId,
      notes: "重启前提交",
    });
    mustBe(replay, 200, "operation replay");
    expect(replay.json).toEqual((operation.json as { result: unknown }).result);
    expect(
      (await stack.snapshot()).records.filter((row) => row.deviceId === device),
    ).toHaveLength(1);

    const conflicting = await client.start(scan.id, device, {
      requestId,
      notes: "不同载荷",
    });
    expect(conflicting.status).toBe(409);
    expect(reportCode(conflicting)).toBe("REQUEST_ID_REUSED");

    mustBe(
      await client.endWithPreview(started.recordId, { notes: "重启后结束" }),
      200,
      "end after restart",
    );
  });

  it("S-I-08/13: 共享口令变更后旧口令与旧 token 失效，原操作与新登录可用", async () => {
    const device = (
      mustBe(
        await client.createDevice({ code: uniqueCode("FC-PASSWORD") }),
        200,
        "create device",
      ).json as { deviceId: string }
    ).deviceId;
    const scan = mustBe(await client.scan(uid("password-change")), 200, "scan")
      .json as PreviewBody;
    const started = mustBe(
      await client.start(scan.id, device, { notes: "改密期间的活动记录" }),
      200,
      "start before password change",
    ).json as RecordBody;
    const oldToken = client.token;
    const newPassword = randomBytes(24).toString("hex");

    try {
      await stack.updateEnv({ TEACHER_PASSWORD: newPassword });
      await stack.recreate("api");

      expect(
        (
          await client.request("GET", "/service-status", undefined, {
            token: oldToken,
          })
        ).status,
      ).toBe(401);
      const oldLogin = await client.login(connection.password);
      expect(oldLogin.status).toBe(401);
      expect(reportCode(oldLogin)).toBe("LOGIN_FAILED");

      mustBe(await client.login(newPassword), 200, "login with new password");
      const status = mustBe(
        await client.serviceStatus(),
        200,
        "status after re-login",
      );
      expect((status.json as { environment: string }).environment).toBe(
        "integration",
      );

      const history = mustBe(
        await client.records({ state: "active" }),
        200,
        "active records after password change",
      );
      expect((history.json as PageBody).items.map((item) => item.id)).toContain(
        started.recordId,
      );
      mustBe(
        await client.endWithPreview(started.recordId, {
          notes: "改密后手动结束",
        }),
        200,
        "end after password change",
      );
    } finally {
      await stack.updateEnv({ TEACHER_PASSWORD: connection.password });
      await stack.recreate("api");
      mustBe(
        await client.login(connection.password),
        200,
        "restore original password",
      );
    }
  });

  it("S-I-08: 服务状态为只读且不存在在线改密/管理端点", async () => {
    const status = mustBe(await client.serviceStatus(), 200, "service status");
    expect(status.json).toMatchObject({
      mode: "normal",
      environment: "integration",
      reasonCodes: [],
    });
    expect(
      (status.json as { allowedActions: string[] }).allowedActions,
    ).toEqual(
      expect.arrayContaining(["read", "scan", "start", "end", "modify"]),
    );
    for (const [method, path] of [
      ["POST", "/auth/password"],
      ["POST", "/auth/users"],
      ["POST", "/admin/password"],
      ["GET", "/service-status/secrets"],
    ] as const) {
      const response: GatewayResponse = await client.request(method, path);
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it("S-I-03: 结束操作的 requestId 在重启后同样幂等", async () => {
    const device = (
      mustBe(
        await client.createDevice({ code: uniqueCode("FC-END-IDEMPOTENT") }),
        200,
        "create device",
      ).json as { deviceId: string }
    ).deviceId;
    const scan = mustBe(await client.scan(uid("end-idempotent")), 200, "scan")
      .json as PreviewBody;
    const started = mustBe(await client.start(scan.id, device), 200, "start")
      .json as RecordBody;
    const preview = mustBe(
      await client.endPreview(started.recordId),
      200,
      "end preview",
    ).json as { id: string; record: { version: number } };
    const requestId = randomUUID();
    mustBe(
      await client.end(started.recordId, preview.id, preview.record.version, {
        requestId,
        notes: "幂等结束",
      }),
      200,
      "end",
    );
    const ended = await client.endPreview(started.recordId);
    expect(ended.status).toBe(409);
    expect(reportCode(ended)).toBe("HISTORY_READ_ONLY");
    await stack.restart("api");
    await client.reauthenticate();
    const replay = mustBe(
      await client.end(started.recordId, preview.id, preview.record.version, {
        requestId,
        notes: "幂等结束",
      }),
      200,
      "end replay",
    );
    expect((replay.json as RecordBody).recordId).toBe(started.recordId);
  });
});
