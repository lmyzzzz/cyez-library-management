import { ApiError } from "@record/protocol";
export interface Transport {
  request(
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<unknown>;
  close(): Promise<void>;
}
export class ClientSDK {
  private token: string | undefined;
  constructor(
    readonly transport: Transport,
    readonly clientId: string,
  ) {}
  get authenticated() {
    return !!this.token;
  }
  async login(username: string, password: string) {
    const result = (await this.transport.request("POST", "/api/v1/auth/login", {
      username,
      password,
      clientId: this.clientId,
    })) as { token: string };
    this.token = result.token;
  }
  async call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!this.token) throw new ApiError("AUTH_REQUIRED", 401);
    try {
      return (await this.transport.request(
        method,
        path,
        body,
        this.token,
      )) as T;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) this.token = undefined;
      throw e;
    }
  }
  async logout() {
    try {
      if (this.token) await this.call("POST", "/api/v1/auth/logout", {});
    } finally {
      this.token = undefined;
    }
  }
  async close() {
    this.token = undefined;
    await this.transport.close();
  }
}
