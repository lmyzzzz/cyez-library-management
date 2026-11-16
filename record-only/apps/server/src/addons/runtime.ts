import { createHash } from "node:crypto";
import { ApiError, type AddonId, type AddonDTO } from "@record/protocol";
import type { Context } from "../previews.js";
import type { Service } from "../service.js";
import { builtins, latestSlot, SCHEDULER_CLIENT_ID } from "./catalog.js";
import { endGradeRecords } from "./executors.js";

const schedulerContext: Context = {
  clientId: SCHEDULER_CLIENT_ID,
  sessionId: "builtin-scheduler",
  username: "builtin-scheduler",
};
function slotId(id: string, at: number) {
  const hex = createHash("sha256")
    .update(`builtin-addon:${id}:${at}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** Only compiled-in catalog entries are loadable. No third-party code, shell,
 * client timers, or school-specific branches inside the business service. */
export class AddonRuntime {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(
    private service: Service,
    private now = Date.now,
    private failed: () => Promise<void> = async () => {},
  ) {}
  async list(): Promise<{ items: AddonDTO[] }> {
    const rows = await this.service.db.addons.findAll();
    return {
      items: builtins.map((definition) => {
        const state = rows.find((row) => row.get().id === definition.id)?.get();
        if (!state) throw new ApiError("ADDON_NOT_READY", 503);
        return {
          id: definition.id,
          name: definition.name,
          ...definition.trigger,
          enabled: state.enabled,
          version: state.version,
          lastRun: state.lastRun,
        };
      }),
    };
  }
  async configure(
    ctx: Context,
    id: AddonId,
    data: { requestId: string; expectedVersion: number; enabled: boolean },
  ) {
    return this.service.operation(
      ctx,
      `addon.configure:${id}`,
      data,
      "modify",
      async (tx) => {
        const row = await this.service.db.addons.findByPk(id, {
          transaction: tx,
          lock: tx.LOCK.UPDATE,
        });
        if (!row) throw new ApiError("NOT_FOUND", 404);
        if (row.get().version !== data.expectedVersion)
          throw new ApiError("ADDON_VERSION_CONFLICT", 409);
        await row.update(
          {
            enabled: data.enabled,
            version: row.get().version + 1,
            enabledAt:
              data.enabled && !row.get().enabled
                ? new Date(this.now())
                : row.get().enabledAt,
          },
          { transaction: tx },
        );
        return { id, enabled: row.get().enabled, version: row.get().version };
      },
    );
  }
  async run(ctx: Context, id: AddonId, requestId: string, slot?: number) {
    const definition = builtins.find((addon) => addon.id === id);
    if (!definition) throw new ApiError("NOT_FOUND", 404);
    const cutoff = slot ?? this.now();
    return this.service.operation(
      ctx,
      `addon.run:${id}`,
      { requestId, ...(slot === undefined ? {} : { slot }) },
      "end",
      async (tx) => {
        const row = await this.service.db.addons.findByPk(id, {
          transaction: tx,
          lock: tx.LOCK.UPDATE,
        });
        if (!row?.get().enabled) throw new ApiError("ADDON_DISABLED", 409);
        if (
          slot !== undefined &&
          (slot <= (row.get().enabledAt?.getTime() ?? Infinity) ||
            slot <= (row.get().lastSlot?.getTime() ?? 0))
        )
          return { count: 0, skipped: true };
        const result = await endGradeRecords(
          this.service,
          ctx,
          tx,
          definition.executor.grades,
          cutoff,
          requestId,
        );
        await row.update(
          {
            lastRun: {
              atMs: this.now(),
              trigger: slot === undefined ? "manual" : "cron",
              count: result.count,
            },
            ...(slot === undefined ? {} : { lastSlot: new Date(slot) }),
          },
          { transaction: tx },
        );
        return result;
      },
    );
  }
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.check().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async check() {
    for (const definition of builtins) {
      try {
        const state = (
          await this.service.db.addons.findByPk(definition.id)
        )?.get();
        if (!state?.enabled) continue;
        const now = this.now(),
          slot = latestSlot(definition, now);
        // Bounded catch-up: only today's due occurrence, never old days or
        // occurrences before enablement. Retry after DB/capacity recovery.
        const day = (ms: number) =>
          new Date(ms).toLocaleDateString("en-CA", {
            timeZone: definition.trigger.timezone,
          });
        if (
          day(slot) !== day(now) ||
          slot <= (state.enabledAt?.getTime() ?? Infinity) ||
          slot <= (state.lastSlot?.getTime() ?? 0)
        )
          continue;
        await this.run(
          schedulerContext,
          definition.id,
          slotId(definition.id, slot),
          slot,
        );
      } catch {
        await this.failed().catch(() => {});
      }
    }
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 10000);
    this.timer.unref();
    void this.tick();
  }
  async close() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
