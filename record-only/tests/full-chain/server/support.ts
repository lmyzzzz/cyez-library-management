import { createHash } from "node:crypto";
import type { FullChainStack } from "../harness/stack.js";
import { sleep, waitFor } from "../harness/stack.js";

/**
 * Deterministic, collision-free 4-byte UIDs for this suite. Reserved UIDs used
 * by the test provider fixture (ffffffff / eeeeeeee / f0f0f0f0) are avoided.
 */
export function uid(label: string): string {
  const value = createHash("sha256")
    .update(`full-chain:${label}`)
    .digest("hex")
    .slice(0, 8);
  if (
    ["ffffffff", "eeeeeeee", "f0f0f0f0", "00000001", "00000002"].includes(value)
  )
    throw new Error(`FULL_CHAIN_UID_RESERVED: ${label}`);
  return value;
}

export function uniqueCode(prefix: string) {
  // Device codes are unique forever (soft-deleted rows keep theirs).
  return `${prefix}-${createHash("sha256")
    .update(`${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 10)}`.toUpperCase();
}

export async function count(
  stack: FullChainStack,
  table: "students" | "records" | "logs",
) {
  return (await stack.snapshot())[table].length;
}

export async function studentRow(stack: FullChainStack, id: string) {
  const row = (await stack.snapshot()).students.find((row) => row.id === id);
  return row ? { name: row.name, version: row.version } : undefined;
}

export async function waitForLogIngest(
  stack: FullChainStack,
  predicate: (counts: Record<string, number>) => boolean,
  timeoutMs = 60_000,
) {
  return waitFor(
    "app_logs origins to be ingested",
    async () => {
      const rows = (await stack.snapshot()).logs;
      const counts: Record<string, number> = {};
      for (const row of rows)
        counts[row.origin] = (counts[row.origin] ?? 0) + 1;
      return predicate(counts) ? counts : false;
    },
    { timeoutMs, intervalMs: 750 },
  );
}

/** Ensure a directory's files are visible (spool drain is asynchronous). */
export async function waitForFiles(
  stack: FullChainStack,
  service: "api" | "gateway" | "db",
  directory: string,
  timeoutMs = 20_000,
) {
  return waitFor(
    `${service}:${directory} to contain files`,
    async () => {
      const files = await stack.listFiles(service, directory);
      return files.length ? files : false;
    },
    { timeoutMs, intervalMs: 500 },
  );
}
