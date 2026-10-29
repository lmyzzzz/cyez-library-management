import { session, net, type ClientRequest, type Session } from "electron";
import { randomUUID } from "node:crypto";
import { ApiError } from "@record/protocol";
import type { Transport } from "@record/client-sdk";
import type { Connection } from "../shared/bridge.js";
import { connectionOrigin, verifyCertificate } from "./pin.js";
export class PinnedTransport implements Transport {
  readonly origin: string;
  readonly session: Session;
  private closed = false;
  private pending = new Set<ClientRequest>();
  constructor(private config: Connection) {
    this.origin = connectionOrigin(config);
    this.session = session.fromPartition(`library-network-${randomUUID()}`, {
      cache: false,
    });
    this.session.setCertificateVerifyProc((request, callback) =>
      callback(
        verifyCertificate(request.certificate.data, request.hostname, config)
          ? 0
          : -2,
      ),
    );
    this.session.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
  }
  async request(
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<unknown> {
    if (
      this.closed ||
      !/^\/(api\/v1\/|health\/)[a-z0-9/?=&%+._-]+$/i.test(path) ||
      path.includes("..")
    )
      throw new ApiError("NETWORK_TARGET_INVALID", 422);
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin)
      throw new ApiError("NETWORK_TARGET_INVALID", 422);
    return new Promise((resolve, reject) => {
      const request = net.request({
        method,
        url: url.href,
        session: this.session,
        redirect: "error",
        credentials: "omit",
        useSessionCookies: false,
      });
      this.pending.add(request);
      const timer = setTimeout(() => {
        finish(new ApiError("NETWORK_TIMEOUT", 503));
        request.abort();
      }, 15000);
      let done = false;
      const finish = (error?: ApiError, result?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(request);
        error ? reject(error) : resolve(result);
      };
      request.setHeader("content-type", "application/json");
      if (token) request.setHeader("authorization", `Bearer ${token}`);
      request.on("redirect", () => {
        finish(new ApiError("REDIRECT_REFUSED", 503));
        request.abort();
      });
      request.on("error", () =>
        finish(new ApiError("TLS_OR_NETWORK_FAILED", 503)),
      );
      request.on("abort", () => finish(new ApiError("NETWORK_ABORTED", 503)));
      request.on("response", (response) => {
        let text = "",
          size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) {
            finish(new ApiError("RESPONSE_TOO_LARGE", 503));
            request.abort();
          } else text += chunk.toString("utf8");
        });
        response.on("error", () => finish(new ApiError("NETWORK_FAILED", 503)));
        response.on("end", () => {
          try {
            const value = JSON.parse(text);
            const status = response.statusCode;
            if (status < 200 || status >= 300)
              finish(
                new ApiError(
                  typeof value.code === "string" &&
                    /^[A-Z_]{1,80}$/.test(value.code)
                    ? value.code
                    : "REQUEST_FAILED",
                  status,
                ),
              );
            else finish(undefined, value);
          } catch {
            finish(new ApiError("RESPONSE_INVALID", 503));
          } finally {
            text = "";
          }
        });
      });
      if (body !== undefined) request.write(JSON.stringify(body));
      request.end();
    });
  }
  async close() {
    this.closed = true;
    for (const request of this.pending) request.abort();
    await this.session.closeAllConnections();
    await this.session.clearCache();
    this.session.setCertificateVerifyProc(null);
  }
}
