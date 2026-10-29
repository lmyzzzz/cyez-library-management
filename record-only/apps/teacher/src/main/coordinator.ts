import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";
import { z } from "zod";
import { ClientSDK } from "@record/client-sdk";
import {
  ApiError,
  parse,
  type ScanPreview,
  type ServiceStatus,
} from "@record/protocol";
import type { IdentityConfig } from "@record/protocol/identity";
import {
  actions,
  connectionSchema,
  type ActionName,
  type Connection,
  type TeacherEvent,
  type SafeLog,
  type LocalStatus,
} from "../shared/bridge.js";
import { PinnedTransport } from "./transport.js";
import { LocalStore } from "./store.js";
import { CardReader, type CardEvent } from "./reader.js";
export class Coordinator {
  sdk: ClientSDK | undefined;
  connection: Connection | null = null;
  online = false;
  lastSuccessMs: number | null = null;
  private gate = { page: "settings", modal: false, submitting: false };
  private scanning = false;
  private writing = false;
  private recovering = false;
  private flushing = false;
  private memoryLogin: { username: string; password: string } | undefined;
  readonly reader: CardReader;
  readerState = "未连接读卡器";
  constructor(
    readonly store: LocalStore,
    readonly clientId: string,
    readonly environment: "development" | "integration" | "production",
    identity: IdentityConfig,
    private emit: (event: TeacherEvent) => void,
  ) {
    this.reader = new CardReader(identity, (event) => this.onCard(event));
  }
  async init() {
    const saved = await this.store.get("connection");
    if (saved) {
      try {
        await this.configure(connectionSchema.parse(JSON.parse(saved)));
      } catch {
        this.emit({ type: "notice", code: "CONNECTION_CONFIGURATION_INVALID" });
      }
    }
    await this.log({ source: "main", level: "info", code: "APP_STARTED" });
  }
  async log(entry: SafeLog) {
    await this.store.append({
      ...entry,
      logId: randomUUID(),
      atMs: Date.now(),
      appVersion: "0.1.0",
    });
  }
  async configure(connection: Connection) {
    await this.sdk?.close();
    this.sdk = undefined;
    this.online = false;
    this.memoryLogin = undefined;
    this.connection = connection;
    const transport = new PinnedTransport(connection);
    this.sdk = new ClientSDK(transport, this.clientId);
    await this.store.set("connection", JSON.stringify(connection));
    this.emit({ type: "changed" });
    return { ok: true };
  }
  async status(): Promise<LocalStatus> {
    const metrics = await this.store.metrics();
    const current = this.sdk
      ? (
          await this.store.pending(
            (this.sdk.transport as PinnedTransport).origin,
          )
        ).length
      : 0;
    return {
      connection: this.connection,
      authenticated: !!this.sdk?.authenticated,
      online: this.online,
      savedCredentials: !!(await this.store.get("credentials")),
      ...metrics,
      pendingCommands: current,
      pendingOtherOrigins: metrics.pendingCommands - current,
      reader: this.readerState,
      environment: this.environment,
      version: "0.1.0",
      lastSuccessMs: this.lastSuccessMs,
    };
  }
  private requireSdk() {
    if (!this.sdk) throw new ApiError("CONNECTION_REQUIRED", 401);
    return this.sdk;
  }
  private async network<T>(work: () => Promise<T>): Promise<T> {
    try {
      const value = await work();
      this.online = true;
      this.lastSuccessMs = Date.now();
      return value;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status === 401 || e.status >= 500) {
        this.online = false;
        this.emit({ type: "changed" });
      }
      throw e;
    }
  }
  async onCard(event: CardEvent) {
    try {
      if (
        this.gate.page !== "devices" ||
        this.gate.modal ||
        this.gate.submitting ||
        this.writing ||
        this.scanning
      ) {
        this.emit({ type: "notice", code: "SCAN_RETURN_TO_DEVICES" });
        return;
      }
      if (!this.online || !this.sdk?.authenticated) {
        this.emit({ type: "notice", code: "OFFLINE_NO_WRITE" });
        return;
      }
      this.scanning = true;
      const preview = await this.network(() =>
        this.sdk!.call<ScanPreview>("POST", "/api/v1/scan-previews", event),
      );
      this.gate.page = "flow";
      this.emit({ type: "scan", preview });
    } catch (e) {
      this.emit({
        type: "notice",
        code: e instanceof ApiError ? e.code : "SCAN_FAILED",
      });
      await this.log({
        source: "reader",
        level: "warn",
        code: "SCAN_FAILED",
        scanId: event.scanId,
      });
    } finally {
      this.scanning = false;
      event.card.uidHex = "";
      event.card.issuer = "";
    }
  }
  async command(method: string, path: string, body: Record<string, unknown>) {
    if (!this.online || !this.requireSdk().authenticated)
      throw new ApiError("OFFLINE_NO_WRITE", 503);
    if (this.writing || this.recovering)
      throw new ApiError("COMMAND_BUSY", 409);
    this.writing = true;
    try {
      const pending = await this.store.pending(
        (this.sdk!.transport as PinnedTransport).origin,
      );
      if (pending.length) throw new ApiError("COMMAND_PENDING", 409);
      const requestId = randomUUID(),
        payload = { ...body, requestId };
      await this.log({
        source: "sdk",
        level: "info",
        code: "COMMAND_PENDING",
        requestId,
      });
      await this.store.saveIntent({
        requestId,
        origin: (this.sdk!.transport as PinnedTransport).origin,
        method,
        path,
        body: payload,
        createdAt: Date.now(),
        state: "pending",
      });
      try {
        const result = await this.network(() =>
          this.sdk!.call(method, path, payload),
        );
        await this.store.write(() =>
          this.store.intents.update(
            { state: "committed" },
            { where: { requestId } },
          ),
        );
        await this.log({
          source: "sdk",
          level: "info",
          code: "COMMAND_COMMITTED",
          requestId,
        });
        return result;
      } catch (e) {
        if (
          e instanceof ApiError &&
          e.status >= 400 &&
          e.status < 500 &&
          e.status !== 401 &&
          e.status !== 429
        ) {
          await this.store.write(() =>
            this.store.intents.update(
              { state: "rejected" },
              { where: { requestId } },
            ),
          );
          throw e;
        }
        throw new ApiError("COMMAND_PENDING", 503);
      }
    } finally {
      this.writing = false;
      this.emit({ type: "changed" });
    }
  }
  async recover() {
    if (this.recovering || this.writing) return { busy: true };
    this.recovering = true;
    try {
      const sdk = this.requireSdk();
      const origin = (sdk.transport as PinnedTransport).origin;
      const outcomes = [];
      for (const intent of await this.store.pending(origin)) {
        try {
          let result: unknown;
          try {
            const op = await sdk.call<{ result: unknown }>(
              "GET",
              `/api/v1/operations/${intent.requestId}`,
            );
            result = op.result;
          } catch (e) {
            if (!(e instanceof ApiError) || e.status !== 404) throw e;
            result = await sdk.call(intent.method, intent.path, intent.body);
          }
          await this.store.write(() =>
            this.store.intents.update(
              { state: "committed" },
              { where: { requestId: intent.requestId } },
            ),
          );
          outcomes.push({
            requestId: intent.requestId,
            state: "committed",
            result,
          });
        } catch (e) {
          if (
            e instanceof ApiError &&
            e.status >= 400 &&
            e.status < 500 &&
            ![401, 429].includes(e.status)
          ) {
            await this.store.write(() =>
              this.store.intents.update(
                { state: "rejected" },
                { where: { requestId: intent.requestId } },
              ),
            );
            outcomes.push({
              requestId: intent.requestId,
              state: "rejected",
              code: e.code,
            });
          } else throw e;
        }
      }
      return { outcomes };
    } finally {
      this.recovering = false;
      this.emit({ type: "changed" });
    }
  }
  async flush() {
    if (this.flushing || !this.online || !this.sdk?.authenticated) return;
    this.flushing = true;
    try {
      const logs = await this.store.logBatch();
      if (logs.length) {
        const result = await this.sdk.call<{ acked: string[] }>(
          "POST",
          "/api/v1/logs/batch",
          { logs },
        );
        await this.store.ack(
          result.acked.filter((id) => logs.some((l) => l.logId === id)),
        );
      }
    } finally {
      this.flushing = false;
    }
  }
  async login(username: string, password: string, remember: boolean) {
    const sdk = this.requireSdk();
    await this.network(() => sdk.login(username, password));
    this.memoryLogin = { username, password };
    let saved = false;
    if (remember && safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(
        JSON.stringify({
          origin: (sdk.transport as PinnedTransport).origin,
          username,
          password,
        }),
      );
      await this.store.set("credentials", encrypted.toString("base64"));
      encrypted.fill(0);
      saved = true;
    } else {
      await this.store.write(() =>
        this.store.settings.destroy({ where: { key: "credentials" } }),
      );
      if (remember)
        this.emit({ type: "notice", code: "SECURE_STORAGE_UNAVAILABLE" });
    }
    const recovery = await this.recover();
    await sdk.call("POST", "/api/v1/clients/startup", { version: "0.1.0" });
    await this.flush();
    return { saved, recovery };
  }
  async call(action: ActionName, input: unknown): Promise<unknown> {
    if (!(action in actions)) throw new ApiError("IPC_ACTION_INVALID", 422);
    const data = parse(actions[action] as z.ZodTypeAny, input) as Record<
      string,
      unknown
    >;
    switch (action) {
      case "configure":
        return this.configure(data as Connection);
      case "status":
        return this.status();
      case "gate":
        this.gate = data as typeof this.gate;
        return { ok: true };
      case "login":
        try {
          return await this.login(
            data.username as string,
            data.password as string,
            data.remember as boolean,
          );
        } finally {
          data.password = "";
        }
      case "loginSaved": {
        const stored = await this.store.get("credentials");
        if (!stored || !safeStorage.isEncryptionAvailable())
          throw new ApiError("SAVED_LOGIN_UNAVAILABLE", 401);
        const credentials = JSON.parse(
          safeStorage.decryptString(Buffer.from(stored, "base64")),
        );
        if (
          credentials.origin !==
          (this.requireSdk().transport as PinnedTransport).origin
        )
          throw new ApiError("SAVED_LOGIN_ORIGIN_MISMATCH", 401);
        try {
          return await this.login(
            credentials.username,
            credentials.password,
            true,
          );
        } finally {
          credentials.password = "";
        }
      }
      case "clearSaved":
        this.memoryLogin = undefined;
        await this.store.write(() =>
          this.store.settings.destroy({ where: { key: "credentials" } }),
        );
        return { ok: true };
      case "logout":
        await this.sdk?.logout();
        this.online = false;
        this.memoryLogin = undefined;
        return { ok: true };
      case "testConnection":
        return this.network(() =>
          this.requireSdk().transport.request("GET", "/health/ready"),
        );
      case "recover":
        return this.recover();
      case "uiError":
        await this.log({
          source: "renderer",
          level: "error",
          code: "UI_ERROR",
        });
        return { ok: true };
      case "integrationScan":
        if (this.environment === "production")
          throw new ApiError("INTEGRATION_DISABLED", 403);
        await this.reader.accept(
          Buffer.from(
            data.fixture === "allowed-1"
              ? "00000001"
              : data.fixture === "allowed-2"
                ? "00000002"
                : "ffffffff",
            "hex",
          ),
          "integration",
        );
        return { ok: true };
    }
    const sdk = this.requireSdk();
    const query = (value: Record<string, unknown>) =>
      new URLSearchParams(
        Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      ).toString();
    if (action === "devices") {
      const [devices, status] = await this.network(() =>
        Promise.all([
          sdk.call("GET", "/api/v1/devices?" + query(data)),
          sdk.call<ServiceStatus>("GET", "/api/v1/service-status"),
        ]),
      );
      return { devices, status };
    }
    if (action === "history")
      return this.network(() =>
        sdk.call("GET", "/api/v1/usage-records?" + query(data)),
      );
    if (action === "tags")
      return this.network(() => sdk.call("GET", "/api/v1/tags"));
    if (!this.online) throw new ApiError("OFFLINE_NO_WRITE", 503);
    if (action === "cancelPreview")
      return sdk.call("DELETE", `/api/v1/scan-previews/${data.previewId}`);
    if (action === "endPreview")
      return sdk.call(
        "POST",
        `/api/v1/usage-records/${data.recordId}/end-preview`,
        {},
      );
    if (action === "batchPreview")
      return sdk.call(
        "POST",
        "/api/v1/usage-records/end-batches/preview",
        data,
      );
    const { recordId, deviceId, tagId, ...body } = data;
    switch (action) {
      case "start":
        return this.command("POST", "/api/v1/usage-records/start", data);
      case "end":
        return this.command(
          "POST",
          `/api/v1/usage-records/${recordId}/end`,
          body,
        );
      case "editNotes":
        return this.command(
          "PATCH",
          `/api/v1/usage-records/${recordId}/notes`,
          body,
        );
      case "batchConfirm":
        return this.command(
          "POST",
          "/api/v1/usage-records/end-batches/confirm",
          data,
        );
      case "createDevice":
        return this.command("POST", "/api/v1/devices", data);
      case "editDevice":
        return this.command("PATCH", `/api/v1/devices/${deviceId}`, body);
      case "deleteDevice":
        return this.command("DELETE", `/api/v1/devices/${deviceId}`, body);
      case "createTag":
        return this.command("POST", "/api/v1/tags", data);
      case "editTag":
        return this.command("PATCH", `/api/v1/tags/${tagId}`, body);
      case "deleteTag":
        return this.command("DELETE", `/api/v1/tags/${tagId}`, body);
      default:
        throw new ApiError("IPC_ACTION_INVALID", 422);
    }
  }
  async close() {
    await this.sdk?.close();
    const deadline = Date.now() + 10000;
    while (
      (this.writing || this.scanning || this.recovering || this.flushing) &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 25));
    await this.store.close();
  }
}
