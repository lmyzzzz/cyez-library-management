import { pathToFileURL } from "node:url";
import { ApiError, profileSchema, type Profile } from "@record/protocol";
import type { CardScanInput } from "@record/protocol/identity";
import type { Config } from "./config.js";
/** Real adapters receive only the transient card and MUST use normal verified HTTPS.
 * Return a profile only when the campus API confirms this student may register.
 * Map an explicit rejection to STUDENT_NOT_ALLOWED; never use a cached profile
 * as a fallback for outages. Do not log raw requests or responses. */
export interface CampusProvider {
  lookup(card: Readonly<CardScanInput>, signal: AbortSignal): Promise<unknown>;
}
export class FakeProvider implements CampusProvider {
  calls = 0;
  async lookup(
    _card: Readonly<CardScanInput>,
    signal: AbortSignal,
  ): Promise<Profile> {
    signal.throwIfAborted();
    this.calls++;
    if (_card.uidHex === "ffffffff")
      throw new ApiError("STUDENT_NOT_ALLOWED", 403);
    return {
      name: "集成测试学生",
      className: "测试班级",
      schoolNumber: "INTEGRATION",
    };
  }
}
export async function loadProvider(config: Config): Promise<CampusProvider> {
  if (config.providerMode === "fake") {
    if (config.environment === "production")
      throw new Error("FAKE_PROVIDER_FORBIDDEN");
    return new FakeProvider();
  }
  const module = await import(pathToFileURL(config.providerModule!).href);
  const provider = await module.createProvider();
  if (typeof provider?.lookup !== "function")
    throw new Error("PROVIDER_ADAPTER_INVALID");
  return provider;
}
export async function refreshProfile(
  provider: CampusProvider,
  card: CardScanInput,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<Profile> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  external?.addEventListener("abort", cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (external?.aborted) throw new Error("ABORTED");
    const value = await Promise.race([
      provider.lookup(card, abort.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new ApiError("PROVIDER_UNAVAILABLE", 503));
        }, timeoutMs);
        abort.signal.addEventListener(
          "abort",
          () => reject(new ApiError("PROVIDER_UNAVAILABLE", 503)),
          { once: true },
        );
      }),
    ]);
    // Adapters select approved fields; arbitrary provider payloads never escape this boundary.
    const result = profileSchema.safeParse(value);
    if (!result.success) throw new ApiError("PROFILE_MISMATCH", 422);
    return result.data;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("PROVIDER_UNAVAILABLE", 503);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", cancel);
    card.uidHex = "";
    card.issuer = "";
  }
}
/** Helper for real adapters; URL is configured by the operator, never by a request. */
export async function providerHttpsJson(
  endpoint: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new ApiError("PROVIDER_CONFIGURATION_INVALID", 503);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new Error("HTTP");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("EMPTY");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 65536) throw new Error("LIMIT");
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      await reader.cancel();
      for (const b of chunks) b.fill(0);
    }
  } catch {
    throw new ApiError("PROVIDER_UNAVAILABLE", 503);
  }
}
