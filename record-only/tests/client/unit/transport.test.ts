// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { certificate } from "../../helpers/certificates.js";

const harness = vi.hoisted(() => ({
  mode: "ok",
  requests: [] as {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }[],
  verify: undefined as
    | undefined
    | ((
        request: { certificate: { data: string }; hostname: string },
        callback: (result: number) => void,
      ) => void),
  closed: 0,
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Request extends EventEmitter {
    headers: Record<string, string> = {};
    body = "";
    constructor(readonly options: { url: string; method: string }) {
      super();
    }
    setHeader(key: string, value: string) {
      this.headers[key] = value;
    }
    write(value: string) {
      this.body += value;
    }
    abort() {
      this.emit("abort");
    }
    end() {
      harness.requests.push({
        url: this.options.url,
        method: this.options.method,
        headers: this.headers,
        body: this.body,
      });
      queueMicrotask(() => {
        if (harness.mode === "error") {
          this.emit("error", Error("socket failed"));
          return;
        }
        if (harness.mode === "redirect") {
          this.emit("redirect");
          return;
        }
        const response = Object.assign(new EventEmitter(), {
          statusCode: harness.mode === "http-error" ? 409 : 200,
        });
        this.emit("response", response);
        if (harness.mode === "response-error") {
          response.emit("error", Error("broken"));
          return;
        }
        response.emit(
          "data",
          Buffer.from(
            harness.mode === "large"
              ? "x".repeat(4 * 1024 * 1024 + 1)
              : harness.mode === "invalid-json"
                ? "not-json"
                : harness.mode === "http-error"
                  ? '{"code":"RECORD_VERSION_CONFLICT"}'
                  : '{"ready":true}',
          ),
        );
        response.emit("end");
      });
    }
  }
  return {
    net: {
      request: (options: { url: string; method: string }) =>
        new Request(options),
    },
    session: {
      fromPartition: () => ({
        setCertificateVerifyProc: (fn: typeof harness.verify) => {
          harness.verify = fn;
        },
        setPermissionRequestHandler: () => {},
        closeAllConnections: async () => {
          harness.closed++;
        },
        clearCache: async () => {},
      }),
    },
  };
});
import { PinnedTransport } from "../../../apps/teacher/src/main/transport.js";

beforeEach(() => {
  harness.mode = "ok";
  harness.requests.length = 0;
  harness.closed = 0;
});
const connection = { ip: "127.0.0.1", port: 8443, pin: "ab".repeat(32) };
describe("C-U 固定 TLS 目标传输", () => {
  it("只向配置 origin 的固定路径发送 JSON/token，关闭后禁止新请求", async () => {
    const transport = new PinnedTransport(connection);
    expect(
      await transport.request(
        "POST",
        "/api/v1/devices",
        { code: "PC-1" },
        "session-token",
      ),
    ).toEqual({ ready: true });
    expect(harness.requests[0]).toMatchObject({
      url: "https://127.0.0.1:8443/api/v1/devices",
      method: "POST",
      body: '{"code":"PC-1"}',
      headers: {
        authorization: "Bearer session-token",
        "content-type": "application/json",
      },
    });
    await expect(
      transport.request("GET", "https://evil.test/steal"),
    ).rejects.toThrow("NETWORK_TARGET_INVALID");
    await expect(transport.request("GET", "/api/v1/../steal")).rejects.toThrow(
      "NETWORK_TARGET_INVALID",
    );
    await transport.close();
    expect(harness.closed).toBe(1);
    await expect(transport.request("GET", "/health/ready")).rejects.toThrow(
      "NETWORK_TARGET_INVALID",
    );
  });

  it("证书校验回调拒绝错误 pin，接受正确 pin", () => {
    const valid = certificate();
    const transport = new PinnedTransport({ ...connection, pin: valid.pin });
    let decision = 99;
    harness.verify!(
      { certificate: { data: valid.cert }, hostname: "127.0.0.1" },
      (n) => {
        decision = n;
      },
    );
    expect(decision).toBe(0);
    harness.verify!(
      { certificate: { data: valid.cert }, hostname: "127.0.0.2" },
      (n) => {
        decision = n;
      },
    );
    expect(decision).toBe(-2);
    void transport.close();
  });

  it.each([
    ["error", "TLS_OR_NETWORK_FAILED"],
    ["redirect", "REDIRECT_REFUSED"],
    ["invalid-json", "RESPONSE_INVALID"],
    ["http-error", "RECORD_VERSION_CONFLICT"],
    ["response-error", "NETWORK_FAILED"],
    ["large", "RESPONSE_TOO_LARGE"],
  ])("%s 显式失败且不返回伪成功", async (mode, code) => {
    harness.mode = mode;
    const transport = new PinnedTransport(connection);
    await expect(transport.request("GET", "/health/ready")).rejects.toThrow(
      code,
    );
    await transport.close();
  });
});
