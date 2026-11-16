import { CronExpressionParser } from "cron-parser";
import type { AddonId } from "@record/protocol";

export const SCHEDULER_CLIENT_ID = "77777777-7777-4777-8777-777777777777";

export interface BuiltinAddon {
  id: AddonId;
  name: string;
  trigger: { cron: string; timezone: string };
  executor: { kind: "end-grade-records"; grades: readonly number[] };
}
export const builtins: readonly BuiltinAddon[] = [
  {
    id: "end-grade-1-2",
    name: "高一、高二午间结束",
    trigger: { cron: "40 12 * * *", timezone: "Asia/Shanghai" },
    executor: { kind: "end-grade-records", grades: [1, 2] },
  },
  {
    id: "end-grade-3",
    name: "高三午间结束",
    trigger: { cron: "30 13 * * *", timezone: "Asia/Shanghai" },
    executor: { kind: "end-grade-records", grades: [3] },
  },
];
/** NFKC normalizes Ⅰ/Ⅱ/Ⅲ; Roman markers must be complete tokens. */
export function classGrade(className: string): number | null {
  const name = className.normalize("NFKC").toUpperCase();
  const chinese = [...name.matchAll(/高\s*([一二三123])(?:年级)?/g)].map(
    (m) => ({ 一: 1, 二: 2, 三: 3, "1": 1, "2": 2, "3": 3 })[m[1]]!,
  );
  const roman = [
    ...name.matchAll(/(?:^|[^A-Z0-9])(III|II|I)(?=$|[^A-Z0-9])/g),
  ].map((m) => m[1].length);
  const matches = new Set([...chinese, ...roman]);
  return matches.size === 1 ? [...matches][0] : null;
}
export function latestSlot(addon: BuiltinAddon, now: number): number {
  return CronExpressionParser.parse(addon.trigger.cron, {
    currentDate: new Date(now + 1),
    tz: addon.trigger.timezone,
  })
    .prev()
    .getTime();
}
