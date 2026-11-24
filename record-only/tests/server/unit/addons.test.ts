import { describe, expect, it } from "vitest";
import {
  builtins,
  classGrade,
  latestSlot,
} from "../../../apps/server/src/addons/catalog.js";

describe("内置加载项年级与北京时间 cron", () => {
  it.each([
    ["I（1班）", 1],
    ["Ⅰ（1班）", 1],
    ["II（2班）", 2],
    ["Ⅱ（2班）", 2],
    ["III（3班）", 3],
    ["Ⅲ（3班）", 3],
    ["高一（1）班", 1],
    ["高二年级", 2],
    ["高三", 3],
    ["CLASS III", 3],
    ["VIII（1）", null],
    ["IIIA", null],
    ["I II", null],
    ["高一 III", null],
    ["集成一班", null],
    ["", null],
  ])("%s 仅匹配一个独立年级", (name, grade) =>
    expect(classGrade(name as string)).toBe(grade),
  );
  it("12:40 和 13:30，不会在凌晨 01:30 执行高三任务", () => {
    expect(
      latestSlot(builtins[0], Date.parse("2026-11-16T12:40:00+08:00")),
    ).toBe(Date.parse("2026-11-16T12:40:00+08:00"));
    expect(
      latestSlot(builtins[1], Date.parse("2026-11-16T01:30:00+08:00")),
    ).toBe(Date.parse("2026-11-15T13:30:00+08:00"));
    expect(
      latestSlot(builtins[1], Date.parse("2026-11-16T13:30:00+08:00")),
    ).toBe(Date.parse("2026-11-16T13:30:00+08:00"));
  });
  it("晚间任务在北京时间 18:15 到期，前一秒尚未到期", () => {
    const addon = builtins.find((item) => item.id === "end-all-evening")!;
    expect(latestSlot(addon, Date.parse("2026-11-24T18:14:59+08:00"))).toBe(
      Date.parse("2026-11-23T18:15:00+08:00"),
    );
    expect(latestSlot(addon, Date.parse("2026-11-24T18:15:00+08:00"))).toBe(
      Date.parse("2026-11-24T18:15:00+08:00"),
    );
  });
});
