import { randomBytes } from "node:crypto";
import { hash, compare } from "bcryptjs";
import { ApiError } from "@record/protocol";
import type { Context } from "./previews.js";
export class Auth {
  private sessions = new Map<string, Context & { expires: number }>();
  private constructor(
    private username: string,
    private passwordHash: string,
    private ttl: number,
    private now = Date.now,
  ) {}
  static async create(
    username: string,
    password: string,
    ttl: number,
    now = Date.now,
  ) {
    return new Auth(username, await hash(password, 12), ttl, now);
  }
  async login(username: string, password: string, clientId: string) {
    const valid = await compare(password, this.passwordHash);
    if (!valid || username !== this.username)
      throw new ApiError("LOGIN_FAILED", 401);
    for (const [key, s] of this.sessions)
      if (s.expires <= this.now()) this.sessions.delete(key);
    if (this.sessions.size >= 10000)
      throw new ApiError("SESSION_CAPACITY", 429);
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, {
      username,
      clientId,
      sessionId: randomBytes(16).toString("hex"),
      expires: this.now() + this.ttl,
    });
    return { token, expiresAtMs: this.now() + this.ttl };
  }
  require(header: unknown): Context {
    if (typeof header !== "string" || !header.startsWith("Bearer "))
      throw new ApiError("AUTH_REQUIRED", 401);
    const token = header.slice(7);
    const s = this.sessions.get(token);
    if (!s || s.expires <= this.now()) {
      this.sessions.delete(token);
      throw new ApiError("AUTH_REQUIRED", 401);
    }
    return s;
  }
  logout(header: string) {
    this.sessions.delete(header.slice(7));
  }
}
