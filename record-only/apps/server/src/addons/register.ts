import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  parse,
  addonIdSchema,
  configureAddonSchema,
  runAddonSchema,
} from "@record/protocol";
import type { Auth } from "../auth.js";
import { AddonRuntime } from "./runtime.js";
export function registerAddons(
  app: FastifyInstance,
  runtime: AddonRuntime,
  auth: Auth,
) {
  const id = (params: unknown) =>
    parse(z.object({ id: addonIdSchema }).strict(), params).id;
  app.get("/api/v1/addons", () => runtime.list());
  app.post("/api/v1/addons/:id/configure", (req) =>
    runtime.configure(
      auth.require(req.headers.authorization),
      id(req.params),
      parse(configureAddonSchema, req.body),
    ),
  );
  app.post("/api/v1/addons/:id/run", (req) =>
    runtime.run(
      auth.require(req.headers.authorization),
      id(req.params),
      parse(runAddonSchema, req.body).requestId,
    ),
  );
  app.addHook("onReady", async () => {
    runtime.start();
  });
}
