import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import type { FullChainConnection } from "./connection.js";

export interface GatewayResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: unknown;
}

export interface GatewayRequestOptions {
  token?: string;
  body?: unknown;
  /** Send these exact bytes instead of JSON-serializing `body`. */
  rawBody?: string | Buffer;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Override the trust anchor (negative TLS tests); defaults to the run cert. */
  ca?: string | Buffer;
  /** Override the expected leaf fingerprint (negative pin tests). */
  expectedPin?: string;
  minVersion?: "TLSv1.2" | "TLSv1.3";
  maxVersion?: "TLSv1.2" | "TLSv1.3";
  path?: string;
}

export function certificatePin(cert: PeerCertificate): string | undefined {
  const raw = (cert as PeerCertificate & { raw?: Buffer }).raw;
  if (!raw) return undefined;
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * HTTPS client that speaks to the real TLS gateway and enforces the deployment
 * certificate pin during the handshake: a wrong pin aborts before any request
 * bytes (credentials or card data) are written.
 */
export class Gateway {
  readonly host: string;
  readonly port: number;
  private readonly ca: Promise<string>;

  constructor(readonly connection: FullChainConnection) {
    const url = new URL(connection.baseUrl);
    this.host = url.hostname;
    this.port = Number(url.port || 443);
    this.ca = readFile(connection.certPemPath, "utf8");
  }

  async request(
    method: string,
    path: string,
    options: GatewayRequestOptions = {},
  ): Promise<GatewayResponse> {
    const ca = options.ca ?? (await this.ca);
    const expectedPin = options.expectedPin ?? this.connection.certPinSha256;
    const headers: Record<string, string | number> = {
      accept: "application/json",
      ...(options.headers ?? {}),
    };
    let payload: Buffer | undefined;
    if (options.rawBody !== undefined)
      payload = Buffer.isBuffer(options.rawBody)
        ? options.rawBody
        : Buffer.from(options.rawBody);
    else if (options.body !== undefined)
      payload = Buffer.from(JSON.stringify(options.body));
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = payload.length;
    }
    if (options.token) headers.authorization = `Bearer ${options.token}`;

    return new Promise<GatewayResponse>((resolve, reject) => {
      const request = httpsRequest(
        {
          host: this.host,
          port: this.port,
          path: options.path ?? path,
          method,
          headers,
          ca,
          minVersion: options.minVersion,
          maxVersion: options.maxVersion,
          rejectUnauthorized: true,
          agent: false,
          checkServerIdentity: (hostname, cert) => {
            const chainFailure = checkServerIdentity(hostname, cert);
            if (chainFailure) return chainFailure;
            const actual = certificatePin(cert);
            if (actual === undefined)
              return new Error("FULL_CHAIN_CERT_UNREADABLE");
            if (actual !== expectedPin)
              return new Error(
                `FULL_CHAIN_CERT_PIN_MISMATCH: expected ${expectedPin} received ${actual}`,
              );
            return undefined;
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 4 * 1024 * 1024) {
              request.destroy(new Error("FULL_CHAIN_RESPONSE_TOO_LARGE"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: unknown = undefined;
            try {
              json = text ? JSON.parse(text) : undefined;
            } catch {
              json = undefined;
            }
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              text,
              json,
            });
          });
          response.on("error", reject);
        },
      );
      request.setTimeout(options.timeoutMs ?? 20_000, () =>
        request.destroy(new Error("FULL_CHAIN_REQUEST_TIMEOUT")),
      );
      request.on("error", reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  async healthLive(): Promise<GatewayResponse> {
    return this.request("GET", "/health/live");
  }

  async healthReady(): Promise<GatewayResponse> {
    return this.request("GET", "/health/ready");
  }

  async login(input: {
    username: string;
    password: string;
    clientId: string;
  }): Promise<GatewayResponse> {
    return this.request("POST", "/api/v1/auth/login", { body: input });
  }

  async api(
    method: string,
    path: string,
    options: GatewayRequestOptions = {},
  ): Promise<GatewayResponse> {
    return this.request(method, "/api/v1" + path, options);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorCode(response: GatewayResponse): unknown {
  return isRecord(response.json) ? response.json.code : undefined;
}
