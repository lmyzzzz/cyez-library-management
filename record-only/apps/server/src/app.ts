import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as P from "@record/protocol";
import { payloadDigest } from "@record/domain";
import type { Config } from "./config.js";
import { Database } from "./database.js";
import { Auth } from "./auth.js";
import { Service } from "./service.js";
import { Spool, Capacity, ingestLogs, type StorageProbe } from "./storage.js";
import { loadProvider, type CampusProvider } from "./provider.js";
import type { Context } from "./previews.js";
export async function createApp(
  config: Config,
  options: {
    database?: Database;
    provider?: CampusProvider;
    probe?: () => Promise<StorageProbe>;
    now?: () => number;
  } = {},
) {
  const db = options.database ?? new Database(config.databaseUrl);
  await db.ready();
  const identity = await db.settings.findByPk("identity");
  if (!identity) throw new Error("IDENTITY_CONFIGURATION_MISSING");
  if (identity.get().value !== payloadDigest("identity", config.identity))
    throw new Error("IDENTITY_CONFIGURATION_CHANGED");
  const spool = new Spool(config.spoolDir);
  await spool.init();
  const capacity = new Capacity(config, spool, options.probe);
  const auth = await Auth.create(
    config.username,
    config.password,
    config.sessionTtlMs,
    options.now,
  );
  const service = new Service(
    db,
    config,
    options.provider ?? (await loadProvider(config)),
    capacity,
    options.now,
  );
  const app = Fastify({
    logger: false,
    bodyLimit: 65536,
    requestTimeout: 15000,
    connectionTimeout: 10000,
    return503OnClosing: true,
    forceCloseConnections: "idle",
  });
  await app.register(rateLimit, { global: false });
  const ctx = (request: { headers: { authorization?: string } }): Context =>
    auth.require(request.headers.authorization);
  const id = (params: unknown) =>
    P.parse(z.object({ id: P.uuid }).strict(), params).id;
  app.addHook("onRequest", async (request) => {
    const route = request.routeOptions.url;
    if (
      route &&
      !route.startsWith("/health/") &&
      route !== "/api/v1/auth/login"
    )
      ctx(request);
  });
  app.setErrorHandler(async (error, request, reply) => {
    const known = error instanceof P.ApiError;
    const statusCode = (error as { statusCode?: number }).statusCode;
    const status = known
      ? error.status
      : statusCode === 413
        ? 413
        : statusCode === 429
          ? 429
          : 503;
    // Never serialize upstream, ORM, AJV or request objects (they may include card input).
    const code = known
      ? error.code
      : status === 413
        ? "BODY_TOO_LARGE"
        : status === 429
          ? "RATE_LIMITED"
          : "SERVICE_UNAVAILABLE";
    if (status >= 500)
      try {
        await spool.append({
          logId: randomUUID(),
          source: "api",
          level: "error",
          atMs: Date.now(),
          appVersion: "0.1.0",
          code: "API_REQUEST_FAILED",
        });
      } catch {
        /* The response remains a failure; no fake persistence ACK. */
      }
    return reply.code(status).send({ code });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ code: "NOT_FOUND" }),
  );
  app.get("/health/live", async () => ({ live: true }));
  app.get("/health/ready", async (_req, reply) => {
    try {
      await db.ready();
      return { ready: true };
    } catch {
      return reply.code(503).send({ code: "NOT_READY" });
    }
  });
  app.post(
    "/api/v1/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: 60000 } } },
    async (req) => {
      const p = P.parse(P.loginSchema, req.body);
      try {
        return await auth.login(p.username, p.password, p.clientId);
      } finally {
        p.password = "";
        if (req.body && typeof req.body === "object")
          (req.body as Record<string, unknown>).password = "";
      }
    },
  );
  app.post("/api/v1/auth/logout", async (req) => {
    auth.logout(req.headers.authorization!);
    return { ok: true };
  });
  app.post("/api/v1/clients/startup", async (req) => {
    const data = P.parse(
      z
        .object({ version: z.string().regex(/^[0-9A-Za-z.+_-]{1,40}$/) })
        .strict(),
      req.body,
    );
    await ingestLogs(db, ctx(req).clientId, [
      {
        logId: randomUUID(),
        source: "main",
        level: "info",
        atMs: Date.now(),
        appVersion: data.version,
        code: "APP_STARTED",
      },
    ]);
    return { ok: true };
  });
  app.get("/api/v1/service-status", async () => {
    const status = await capacity.status();
    if (!service.providerHealthy)
      status.reasonCodes.push("PROVIDER_UNAVAILABLE");
    return status;
  });
  app.post("/api/v1/scan-previews", async (req, reply) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.raw.once("aborted", abort);
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    try {
      return await service.scan(
        ctx(req),
        P.parse(P.scanSchema, req.body),
        controller.signal,
      );
    } finally {
      req.raw.removeListener("aborted", abort);
      req.body = undefined;
    }
  });
  app.delete("/api/v1/scan-previews/:id", async (req) => {
    service.previews.delete(id(req.params), ctx(req));
    return { ok: true };
  });
  app.get("/api/v1/devices", async (req) =>
    service.listDevices(P.parse(P.listSchema, req.query)),
  );
  app.post("/api/v1/devices", async (req) =>
    service.device(ctx(req), null, P.parse(P.createDeviceSchema, req.body)),
  );
  app.patch("/api/v1/devices/:id", async (req) =>
    service.device(
      ctx(req),
      id(req.params),
      P.parse(P.editDeviceSchema, req.body),
    ),
  );
  app.delete("/api/v1/devices/:id", async (req) =>
    service.device(
      ctx(req),
      id(req.params),
      P.parse(P.deleteSchema, req.body),
      true,
    ),
  );
  app.get("/api/v1/tags", async () => ({
    items: (await db.tags.findAll({ order: [["name", "ASC"]] })).map((t) => ({
      id: t.get().id,
      name: t.get().name,
      version: t.get().version,
    })),
  }));
  app.post("/api/v1/tags", async (req) =>
    service.tag(ctx(req), null, P.parse(P.createTagSchema, req.body)),
  );
  app.patch("/api/v1/tags/:id", async (req) =>
    service.tag(ctx(req), id(req.params), P.parse(P.editTagSchema, req.body)),
  );
  app.delete("/api/v1/tags/:id", async (req) =>
    service.tag(
      ctx(req),
      id(req.params),
      P.parse(P.deleteSchema, req.body),
      true,
    ),
  );
  app.get("/api/v1/usage-records", async (req) =>
    service.listRecords(P.parse(P.listSchema, req.query)),
  );
  app.post("/api/v1/usage-records/start", async (req) =>
    service.start(ctx(req), P.parse(P.startSchema, req.body)),
  );
  app.post("/api/v1/usage-records/:id/end-preview", async (req) => {
    P.parse(z.object({}).strict(), req.body ?? {});
    return service.endPreview(ctx(req), id(req.params));
  });
  app.post("/api/v1/usage-records/:id/end", async (req) =>
    service.end(ctx(req), id(req.params), P.parse(P.endSchema, req.body)),
  );
  app.patch("/api/v1/usage-records/:id/notes", async (req) =>
    service.editNotes(
      ctx(req),
      id(req.params),
      P.parse(P.noteSchema, req.body),
    ),
  );
  app.post("/api/v1/usage-records/end-batches/preview", async (req) =>
    service.batchPreview(ctx(req), P.parse(P.batchPreviewSchema, req.body)),
  );
  app.post("/api/v1/usage-records/end-batches/confirm", async (req) =>
    service.batchConfirm(ctx(req), P.parse(P.batchConfirmSchema, req.body)),
  );
  app.get("/api/v1/operations/:id", async (req, reply) => {
    const op = await db.operations.findOne({
      where: { clientId: ctx(req).clientId, requestId: id(req.params) },
    });
    return op
      ? { committed: true, result: op.get().result }
      : reply.code(404).send({ code: "OPERATION_NOT_FOUND" });
  });
  app.post("/api/v1/logs/batch", async (req) => {
    const logs = P.parse(P.logBatchSchema, req.body).logs;
    if (logs.some((l) => ["api", "gateway", "db"].includes(l.source)))
      throw new P.ApiError("LOG_SOURCE_INVALID", 422);
    return ingestLogs(db, ctx(req).clientId, logs);
  });
  app.addHook("onClose", async () => {
    await db.close();
  });
  return { app, db, auth, service, capacity, spool };
}
