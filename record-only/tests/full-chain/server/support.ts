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

export async function psqlValue(
  stack: FullChainStack,
  sql: string,
): Promise<string> {
  const rows = await stack.rows(sql);
  return rows[0]?.[0] ?? "";
}

export async function count(
  stack: FullChainStack,
  sql: string,
): Promise<number> {
  return Number(await psqlValue(stack, sql));
}

export async function studentRow(
  stack: FullChainStack,
  id: string,
): Promise<{ name: string; version: number } | undefined> {
  const rows = await stack.rows(
    `SELECT name, version FROM students WHERE id = '${id}'`,
  );
  const row = rows[0];
  return row ? { name: row[0], version: Number(row[1]) } : undefined;
}

export async function waitForLogIngest(
  stack: FullChainStack,
  predicate: (counts: Record<string, number>) => boolean,
  timeoutMs = 60_000,
) {
  return waitFor(
    "app_logs origins to be ingested",
    async () => {
      const rows = await stack.rows(
        "SELECT origin, count(*) FROM app_logs GROUP BY origin",
      );
      const counts: Record<string, number> = {};
      for (const [origin, number] of rows) counts[origin] = Number(number);
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
