import { ApiError } from "@record/protocol";
import { createHash } from "node:crypto";
export function assertInterval(start: number, end: number): void {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start
  )
    throw new ApiError("TIME_RANGE_CONFLICT", 409);
}
export function appendBatchNotes(original: string, addition: string): string {
  const result = addition
    ? `${original ? original + "\n" : ""}批量结束备注：${addition}`
    : original;
  if (result.length > 8000) throw new ApiError("NOTES_TOO_LONG", 422);
  return result;
}
export function assertAssignable(
  device: { deletedAt: Date | null; isDisabled: boolean },
  active: boolean,
): void {
  if (device.deletedAt || device.isDisabled || active)
    throw new ApiError("DEVICE_UNAVAILABLE", 409);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function payloadDigest(route: string, payload: unknown): string {
  return createHash("sha256")
    .update(route)
    .update("\0")
    .update(canonical(payload))
    .digest("hex");
}
/** Each key has FIFO execution; the map releases completed keys, including rejected tasks. */
export class SerialKeys {
  private tails = new Map<string, Promise<unknown>>();
  get size() {
    return this.tails.size;
  }
  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.tails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }
}
