import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { loadConnection } from "../harness/connection.js";
import { createStack } from "../harness/stack.js";
import { Gateway } from "../harness/gateway.js";
import { foreignCertificate } from "../harness/env.js";

const connection = await loadConnection();
const stack = await createStack(connection);
const gateway = stack.gateway;

function httpDowngrade() {
  return new Promise<{ status?: number; error?: string }>((resolve) => {
    const request = httpRequest(
      {
        host: gateway.host,
        port: gateway.port,
        path: "/health/live",
        method: "GET",
        timeout: 5000,
      },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode });
      },
    );
    request.on("error", (error) => resolve({ error: error.message }));
    request.on("timeout", () => {
      request.destroy();
      resolve({ error: "timeout" });
    });
    request.end();
  });
}

describe("全链路：网关 TLS、路由白名单与部署隔离", () => {
  it("健康检查通过真实网关 TLS，叶子证书指纹与 run 配置一致", async () => {
    const live = await gateway.healthLive();
    expect(live.status).toBe(200);
    expect(live.json).toEqual({ live: true });
    const ready = await gateway.healthReady();
    expect(ready.status).toBe(200);
    expect(ready.json).toEqual({ ready: true });
  });

  it("TLS 1.2 与 TLS 1.3 均可建立连接", async () => {
    for (const version of ["TLSv1.2", "TLSv1.3"] as const) {
      const response = await gateway.request("GET", "/health/live", {
        minVersion: version,
        maxVersion: version,
      });
      expect(response.status, version).toBe(200);
    }
  });

  it("错误 pin 在握手阶段拒绝，请求正文不会发送", async () => {
    const mismatched = new Gateway({
      ...connection,
      certPinSha256: "00".repeat(32),
    });
    await expect(
      mismatched.request("POST", "/api/v1/auth/login", {
        body: {
          username: connection.username,
          password: connection.password,
          clientId: "00000000-0000-4000-8000-000000000000",
        },
      }),
    ).rejects.toThrow(/FULL_CHAIN_CERT_PIN_MISMATCH/);
  });

  it("非本次部署证书在握手阶段拒绝", async () => {
    const foreign = foreignCertificate();
    await expect(
      gateway.request("GET", "/health/live", { ca: foreign.cert }),
    ).rejects.toThrow();
  });

  it("仅 TLS 入口可达，明文 HTTP 被拒绝", async () => {
    const result = await httpDowngrade();
    if (result.status !== undefined)
      expect([400, 497]).toContain(result.status);
    else expect(result.error).toBeTruthy();
  });

  it("网关只转发白名单路由，其他路径返回 404", async () => {
    for (const path of [
      "/",
      "/api/v1/students",
      "/api/v1/administrators",
      "/api/v1/logs/batch/read",
      "/internal/debug",
    ]) {
      const response = await gateway.request("GET", path, {
        // Unauthenticated requests must be rejected by nginx before the API.
        headers: { authorization: "Bearer invalid" },
      });
      expect(response.status, path).toBe(404);
    }
    const unauthenticated = await gateway.request(
      "GET",
      "/api/v1/service-status",
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.json).toEqual({ code: "AUTH_REQUIRED" });
    await expect(gateway.request("GET", "/health/live")).resolves.toMatchObject(
      {
        status: 200,
      },
    );
  });

  it("超过网关请求体上限的刷卡/登录正文被拒绝", async () => {
    const response = await gateway.request("POST", "/api/v1/auth/login", {
      rawBody: "a".repeat(70 * 1024),
    });
    expect(response.status).toBe(413);
  });

  it("网关访问日志仅含状态与耗时，不记录 URL、正文或口令", async () => {
    const login = await gateway.login({
      username: connection.username,
      password: connection.password,
      clientId: "00000000-0000-4000-8000-000000000001",
    });
    expect([200, 401]).toContain(login.status);
    const log = await stack.readFile("gateway", "/var/log/cyez/access.jsonl");
    const lines = log.replace(/\r\n/g, "\n").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(entry).sort()).toEqual(["at", "elapsed", "status"]);
      expect(typeof entry.status).toBe("number");
    }
    expect(log).not.toContain("login");
    expect(log).not.toContain("/api/");
    expect(log).not.toContain(connection.password);
    const errors = await stack.readFile("gateway", "/var/log/cyez/error.log");
    expect(errors).not.toContain(connection.password);
  });

  it("API spool 与 HTTP 错误不持久化登录口令或原始卡号", async () => {
    // Trigger an API level error with a distinctive card body.
    const client = new Gateway(connection);
    const login = await client.login({
      username: connection.username,
      password: connection.password,
      clientId: "00000000-0000-4000-8000-000000000002",
    });
    expect(login.status).toBe(200);
    const token = (login.json as { token: string }).token;
    const uid = "00abcdef";
    const response = await client.request("POST", "/api/v1/scan-previews", {
      token,
      body: {
        scanId: "00000000-0000-4000-8000-000000000003",
        studentId: "0".repeat(64),
        hashVersion: connection.identity.hashVersion,
        card: { issuer: connection.identity.issuer, uidHex: uid },
        source: "integration",
      },
    });
    expect(response.status).toBe(422);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const spool = await stack.readDirectory("api", "/data/api-spool");
    expect(spool).not.toContain(connection.password);
    expect(spool).not.toContain(uid);
  });

  describe.skipIf(connection.mode !== "docker")(
    "S-I-15 Compose 网络与端口隔离",
    () => {
      it("仅 gateway 发布宿主端口，其余服务不发布", async () => {
        const states = await stack.composePs();
        const publishedFor = (service: string) =>
          states
            .filter((state) => state.Service === service)
            .flatMap((state) => state.Publishers ?? [])
            .filter((publisher) => (publisher.PublishedPort ?? 0) > 0);
        expect(publishedFor("gateway").map((p) => p.PublishedPort)).toEqual([
          Number(new URL(connection.baseUrl).port),
        ]);
        for (const service of ["api", "db", "log-ingest"])
          expect(publishedFor(service), service).toEqual([]);
        expect(
          states
            .filter((state) => state.Service === "migrate")
            .every((state) => state.State === "exited" && state.ExitCode === 0),
        ).toBe(true);
      });

      it("网络成员与只读、权限收紧符合部署设计", async () => {
        const containers = await stack.inspect();
        const byService = new Map(
          containers.map((container) => [container.service, container]),
        );
        const networks = (service: string) =>
          (byService.get(service)?.networks ?? []).map((name) =>
            name.replace(`${connection.docker!.project}_`, ""),
          );
        expect(networks("db").sort()).toEqual(["backend"]);
        expect(networks("gateway").sort()).toEqual(["frontend"]);
        expect(networks("log-ingest").sort()).toEqual(["backend"]);
        expect(networks("api").sort()).toEqual([
          "backend",
          "egress",
          "frontend",
        ]);
        for (const service of ["api", "gateway", "db", "log-ingest"]) {
          const container = byService.get(service);
          expect(container, service).toBeTruthy();
          expect(container!.privileged, service).toBe(false);
          expect(container!.capAdd, service).toEqual([]);
          expect(container!.capDrop, service).toContain("ALL");
          expect(container!.readonlyRootfs, service).toBe(true);
          expect(container!.securityOpt.join(" "), service).toContain(
            "no-new-privileges:true",
          );
          expect(container!.hostNetwork, service).toBe(false);
        }
        for (const container of containers)
          expect(
            container.mounts.map((mount) => mount.destination),
            container.name,
          ).not.toContain("/var/run/docker.sock");
      });

      it("migrate 容器正常退出并完成 schema 升级", async () => {
        const rows = await stack.rows(
          'SELECT name FROM "SequelizeMeta" ORDER BY name',
        );
        const names = rows.map((row) => row[0]);
        expect(names).toEqual(
          expect.arrayContaining([
            "001-initial",
            "002-student-cache",
            "003-provider-config",
          ]),
        );
        const roles = await stack.rows(
          "SELECT name FROM role_migrations ORDER BY name",
        );
        expect(roles.map((row) => row[0])).toEqual([
          "001-runtime-role",
          "002-student-cache-insert",
          "003-provider-config",
        ]);
      });
    },
  );
});
