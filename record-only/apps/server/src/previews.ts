import { randomUUID } from "node:crypto";
import { ApiError, type RecordDTO } from "@record/protocol";
export interface Context {
  clientId: string;
  sessionId: string;
  username: string;
}
export interface Intent {
  id: string;
  clientId: string;
  sessionId: string;
  expiresAtMs: number;
  atMs: number;
  mode: "start" | "end" | "batch";
  studentId?: string;
  studentVersion?: number;
  records: RecordDTO[];
}
export class Previews {
  readonly entries = new Map<string, Intent>();
  constructor(
    private ttl: number,
    private limit: number,
    private now = Date.now,
  ) {}
  prune() {
    for (const [key, v] of this.entries)
      if (v.expiresAtMs <= this.now()) this.entries.delete(key);
  }
  create(
    ctx: Context,
    data: Omit<Intent, "id" | "clientId" | "sessionId" | "expiresAtMs">,
  ): Intent {
    this.prune();
    if (this.entries.size >= this.limit)
      throw new ApiError("PREVIEW_CAPACITY", 429);
    const value = {
      ...data,
      id: randomUUID(),
      clientId: ctx.clientId,
      sessionId: ctx.sessionId,
      expiresAtMs: this.now() + this.ttl,
    };
    this.entries.set(value.id, value);
    return value;
  }
  get(id: string, ctx: Context): Intent {
    this.prune();
    const p = this.entries.get(id);
    if (!p) throw new ApiError("PREVIEW_EXPIRED", 410);
    if (p.clientId !== ctx.clientId || p.sessionId !== ctx.sessionId)
      throw new ApiError("PREVIEW_FORBIDDEN", 403);
    return p;
  }
  delete(id: string, ctx: Context) {
    this.get(id, ctx);
    this.entries.delete(id);
  }
}
