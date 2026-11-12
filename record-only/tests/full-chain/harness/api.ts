import { randomUUID } from "node:crypto";
import { studentId } from "@record/protocol/identity";
import type { FullChainConnection } from "./connection.js";
import { Gateway, errorCode, type GatewayResponse } from "./gateway.js";
export type { GatewayResponse } from "./gateway.js";

export interface ScanOptions {
  scanId?: string;
  uidHex?: string;
  source?: "reader" | "integration";
  hashVersion?: string;
  /** Overrides the computed studentId to exercise CARD_ID_MISMATCH. */
  studentIdOverride?: string;
  issuer?: string;
}

/**
 * One logical teacher client talking to the real gateway. A client keeps its
 * clientId across re-logins so persisted operation results stay addressable.
 */
export class FullChainClient {
  readonly gateway: Gateway;
  readonly clientId: string;
  token: string | undefined;

  constructor(
    readonly connection: FullChainConnection,
    clientId = randomUUID(),
  ) {
    this.gateway = new Gateway(connection);
    this.clientId = clientId;
  }

  studentIdFor(uidHex: string, issuer = this.connection.identity.issuer) {
    return studentId({ issuer, uidHex }, this.connection.identity);
  }

  async login(
    password = this.connection.password,
    username = this.connection.username,
  ) {
    const response = await this.gateway.login({
      username,
      password,
      clientId: this.clientId,
    });
    if (response.status === 200) {
      this.token = (response.json as { token: string }).token;
    }
    return response;
  }

  async reauthenticate() {
    const response = await this.login();
    if (response.status !== 200)
      throw new Error(
        `FULL_CHAIN_LOGIN_FAILED: ${response.status} ${response.text}`,
      );
    return this.token!;
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    options: {
      token?: string;
      rawBody?: string | Buffer;
      timeoutMs?: number;
    } = {},
  ): Promise<GatewayResponse> {
    return this.gateway.api(method, path, {
      body,
      rawBody: options.rawBody,
      token: options.token ?? this.token,
      timeoutMs: options.timeoutMs,
    });
  }

  async scan(uidHex: string, options: ScanOptions = {}) {
    const issuer = options.issuer ?? this.connection.identity.issuer;
    return this.request("POST", "/scan-previews", {
      scanId: options.scanId ?? randomUUID(),
      studentId: options.studentIdOverride ?? this.studentIdFor(uidHex, issuer),
      hashVersion: options.hashVersion ?? this.connection.identity.hashVersion,
      card: { issuer, uidHex },
      source: options.source ?? "integration",
    });
  }

  async cancelPreview(previewId: string) {
    return this.request("DELETE", `/scan-previews/${previewId}`);
  }

  async serviceStatus() {
    return this.request("GET", "/service-status");
  }

  async startup(version = "0.1.0") {
    return this.request("POST", "/clients/startup", { version });
  }

  async devices(query: Record<string, string | number> = {}) {
    const search = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    ).toString();
    return this.request("GET", `/devices${search ? "?" + search : ""}`);
  }

  async createDevice(fields: {
    code: string;
    displayName?: string;
    notes?: string;
    isDisabled?: boolean;
    tagIds?: string[];
    requestId?: string;
  }) {
    return this.request("POST", "/devices", {
      requestId: fields.requestId ?? randomUUID(),
      code: fields.code,
      displayName: fields.displayName ?? fields.code,
      notes: fields.notes ?? "",
      isDisabled: fields.isDisabled ?? false,
      tagIds: fields.tagIds ?? [],
    });
  }

  async editDevice(
    deviceId: string,
    expectedVersion: number,
    fields: Partial<{
      code: string;
      displayName: string;
      notes: string;
      isDisabled: boolean;
      tagIds: string[];
      requestId: string;
    }> = {},
  ) {
    return this.request("PATCH", `/devices/${deviceId}`, {
      requestId: fields.requestId ?? randomUUID(),
      expectedVersion,
      code: fields.code ?? "device",
      displayName: fields.displayName ?? "device",
      notes: fields.notes ?? "",
      isDisabled: fields.isDisabled ?? false,
      tagIds: fields.tagIds ?? [],
    });
  }

  async deleteDevice(
    deviceId: string,
    expectedVersion: number,
    requestId = randomUUID(),
  ) {
    return this.request("DELETE", `/devices/${deviceId}`, {
      requestId,
      expectedVersion,
    });
  }

  async tags() {
    return this.request("GET", "/tags");
  }

  async createTag(name: string, requestId = randomUUID()) {
    return this.request("POST", "/tags", { requestId, name });
  }

  async records(query: Record<string, string | number> = { state: "ended" }) {
    const search = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    ).toString();
    return this.request("GET", `/usage-records?${search}`);
  }

  async start(
    previewId: string,
    deviceId: string,
    options: { notes?: string; requestId?: string } = {},
  ) {
    return this.request("POST", "/usage-records/start", {
      requestId: options.requestId ?? randomUUID(),
      previewId,
      deviceId,
      notes: options.notes ?? "",
    });
  }

  async endPreview(recordId: string) {
    return this.request("POST", `/usage-records/${recordId}/end-preview`, {});
  }

  async end(
    recordId: string,
    previewId: string,
    expectedVersion: number,
    options: { notes?: string; requestId?: string } = {},
  ) {
    return this.request("POST", `/usage-records/${recordId}/end`, {
      requestId: options.requestId ?? randomUUID(),
      previewId,
      expectedVersion,
      notes: options.notes ?? "",
    });
  }

  async endWithPreview(
    recordId: string,
    options: { notes?: string; requestId?: string } = {},
  ) {
    const preview = await this.endPreview(recordId);
    if (preview.status !== 200)
      throw new Error(`END_PREVIEW_FAILED: ${preview.status} ${preview.text}`);
    const body = preview.json as {
      id: string;
      record: { version: number; notes: string };
    };
    return this.request("POST", `/usage-records/${recordId}/end`, {
      requestId: options.requestId ?? randomUUID(),
      previewId: body.id,
      expectedVersion: body.record.version,
      notes: options.notes ?? body.record.notes,
    });
  }

  async editNotes(
    recordId: string,
    expectedVersion: number,
    notes: string,
    requestId = randomUUID(),
  ) {
    return this.request("PATCH", `/usage-records/${recordId}/notes`, {
      requestId,
      expectedVersion,
      notes,
    });
  }

  async batchPreview(body: {
    scope: "all" | "selected" | "filtered";
    recordIds?: string[];
  }) {
    return this.request("POST", "/usage-records/end-batches/preview", body);
  }

  async batchConfirm(
    previewId: string,
    options: { notes?: string; requestId?: string } = {},
  ) {
    return this.request("POST", "/usage-records/end-batches/confirm", {
      requestId: options.requestId ?? randomUUID(),
      previewId,
      notes: options.notes ?? "",
    });
  }

  async operation(requestId: string) {
    return this.request("GET", `/operations/${requestId}`);
  }

  async logsBatch(logs: unknown[]) {
    return this.request("POST", "/logs/batch", { logs });
  }
}

export function mustBe(
  response: GatewayResponse,
  status: number,
  context: string,
): GatewayResponse {
  if (response.status !== status)
    throw new Error(
      `FULL_CHAIN_UNEXPECTED_STATUS: ${context}: expected ${status} got ${response.status} (${reportCode(response)}) ${response.text.slice(0, 500)}`,
    );
  return response;
}

export function reportCode(response: GatewayResponse) {
  return errorCode(response) ?? "NO_CODE";
}

export async function loginClient(connection: FullChainConnection) {
  const client = new FullChainClient(connection);
  const response = await client.login();
  if (response.status !== 200)
    throw new Error(
      `FULL_CHAIN_LOGIN_FAILED: ${response.status} ${response.text}`,
    );
  return client;
}
