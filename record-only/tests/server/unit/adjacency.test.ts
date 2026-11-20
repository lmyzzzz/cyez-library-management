import { describe, it, expect } from "vitest";
import {
  ADJACENCY_GRADES,
  DEFAULT_LAYOUT_SETTINGS,
  layoutSettingsSchema,
  layoutUpdateSchema,
  batchCloseSchema,
  batchAssignConfirmSchema,
  batchJoinSchema,
  experimentToggleSchema,
  experimentListSchema,
  scanSchema,
  type LayoutSettings,
} from "@record/protocol";
import {
  parseDeviceCode,
  deviceCells,
  deviceArea,
  adjacencyGradeOf,
  scoreArrangement,
  planSeats,
  spanOf,
  GRADE_LABELS,
  GRADE_RANK,
  seatNumberFromName,
  resolveSeat,
  runOf,
} from "@record/domain";

const defaults: LayoutSettings = DEFAULT_LAYOUT_SETTINGS;
const withSettings = (patch: Partial<LayoutSettings>): LayoutSettings => ({
  ...defaults,
  ...patch,
});
const pair = (a: string, b: string, settings: LayoutSettings = defaults) =>
  adjacencyGradeOf(a, b, settings);

/**
 * 占位段 0：既不满足区域一（≥1），也不满足区域二（≥2），也不满足区域三（≥S3），
 * 所以 `1-0-0` 的几何只由第 1 段决定。注意 99999 落在区域二范围内，
 * 只能用作第 2 段占位，不能当作“无归属”占位。
 */
const P = "0";
const a1 = (v: number) => `${v}-${P}-${P}`;
const a2 = (v: number) => `${P}-${v}-${P}`;
const a3 = (v: number) => `${P}-${P}-${v}`;

describe("S-U 相邻几何：编号解析", () => {
  it("三段数字编号解析成功", () => {
    expect(parseDeviceCode("1-21-41")).toEqual({ a: 1, b: 21, c: 41 });
    expect(parseDeviceCode("3-24-46")).toEqual({ a: 3, b: 24, c: 46 });
    expect(parseDeviceCode("1/21/41")).toEqual({ a: 1, b: 21, c: 41 });
    expect(parseDeviceCode("1_21_41")).toEqual({ a: 1, b: 21, c: 41 });
    expect(parseDeviceCode("0-0-0")).toEqual({ a: 0, b: 0, c: 0 });
    expect(parseDeviceCode("99999-99999-99999")).toEqual({
      a: 99999,
      b: 99999,
      c: 99999,
    });
  });
  it("非三段 / 非数字 / 越界 / 空段编号为几何未知", () => {
    for (const code of [
      "A-01",
      "1234567",
      "1-2-3-4",
      "1",
      "",
      "  ",
      "-1-21-41",
      "1-21-41-",
      "1--21-41",
      "1-21-100000",
      "1.21.41.5",
    ])
      expect(parseDeviceCode(code)).toBeNull();
    expect(parseDeviceCode(undefined as unknown as string)).toBeNull();
  });
});

describe("S-U 相邻几何：分界点与区域归属", () => {
  it("默认 S1=8、S3=41 的段落归属", () => {
    // 区域二从 section2Start=31 起编号，因此 31 的 pos 是 1、32 的 pos 是 2。
    const cells = deviceCells("1-31-41", defaults);
    expect(cells[0]).toMatchObject({ segment: 1, area: 1, pos: 1 });
    expect(cells[1]).toMatchObject({ segment: 2, area: 2, pos: 1 });
    expect(cells[2]).toMatchObject({ segment: 3, area: 3, pos: 1 });
    expect(deviceCells("1-32-41", defaults)[1]).toMatchObject({
      area: 2,
      pos: 2,
    });
    // 21 早于区域二起点 31，不属于区域二。
    expect(deviceCells("1-21-41", defaults)[1]).toBeNull();
    expect(deviceArea(a1(1), defaults)).toBe(1);
    expect(deviceArea(a1(3), defaults)).toBe(1);
    expect(deviceArea(a2(31), defaults)).toBe(2);
    expect(deviceArea(a3(45), defaults)).toBe(3);
    expect(deviceArea(a3(41), defaults)).toBe(3);
  });
  it("多段归属不同区域时 deviceArea 取第 1 段所在区域", () => {
    // 文档 §1 约定：设备房间取第 1 段；第 1 段无归属时取第一个有归属的段。
    expect(deviceArea("1-31-41", defaults)).toBe(1);
    expect(deviceArea("3-34-46", defaults)).toBe(1);
    expect(deviceArea("0-31-41", defaults)).toBe(2);
    expect(deviceArea("0-0-41", defaults)).toBe(3);
    expect(deviceArea("0-0-0", defaults)).toBeNull();
    // 第 1 段超出区域一（21 不在 [1,8)），第 2 段 31 属区域二。
    expect(deviceArea("21-31-41", defaults)).toBe(2);
  });
  it("自定义分界点改变归属", () => {
    // 默认 S1=8 时 1..7 属区域一，S1=16 时 1..15 属区域一。
    const wider = withSettings({ section1End: 16 });
    expect(deviceArea(a1(5), defaults)).toBe(1);
    expect(deviceArea(a1(7), defaults)).toBe(1);
    expect(deviceArea(a1(9), wider)).toBe(1);
    expect(deviceArea(a1(15), wider)).toBe(1);
    expect(deviceCells(a1(9), wider)[0]).toMatchObject({ area: 1, pos: 9 });
    expect(deviceArea(a1(9), defaults)).toBeNull();
    const later = withSettings({ section3Start: 45 });
    expect(deviceArea(a3(41), later)).toBeNull();
    expect(deviceArea(a3(45), later)).toBe(3);
    expect(deviceCells(a3(45), later)[2]).toMatchObject({ area: 3, pos: 1 });
  });
  it("非法 settings 与空输入确定性返回", () => {
    expect(deviceCells("1-21-41", null as unknown as LayoutSettings)).toEqual([
      null,
      null,
      null,
    ]);
    expect(deviceArea("1-21-41", null as unknown as LayoutSettings)).toBeNull();
    expect(spanOf([], defaults)).toBe(0);
    expect(planSeats([], 1, defaults)).toBeNull();
    expect(scoreArrangement([], defaults)).toEqual({
      grade: "clustered",
      span: 0,
      crossArea: false,
      run: 0,
    });
  });
});

describe("S-U 相邻几何：区域一四人桌", () => {
  // 默认 section1End=16 ⇒ 区域一占 [1, 16)，可用 1..15（三张完整四人桌）。
  // docs §1.1：一桌四台按 1 2 3 4 递增，再下一桌 5 6 7 8。
  const wide = withSettings({ section1End: 16 });

  it("同一短边并排 = excellent（用户硬要求：3 4 / 5 6 必须最好）", () => {
    for (const [a, b] of [
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
    ]) {
      expect(pair(a1(a), a1(b), wide)).toBe("excellent");
      expect(pair(a1(b), a1(a), wide)).toBe("excellent");
    }
  });
  it("相邻桌角对角 = good（回头就能看到对方屏幕）", () => {
    // 3 是桌0 的 corner 2，5 是桌1 的 corner 0；4/6、7/9 同理。
    // 用户原话：“3 5 中间是走廊，他们分别在两张桌子上面” ⇒ 回头可见。
    for (const [a, b] of [
      [3, 5],
      [4, 6],
      [7, 9],
      [8, 10],
    ]) {
      expect(pair(a1(a), a1(b), wide)).toBe("good");
      expect(pair(a1(b), a1(a), wide)).toBe("good");
    }
  });
  it("同桌面对面与斜对角都是 degraded（看不见对方屏幕，用户明确说不好）", () => {
    for (const [a, b] of [
      [1, 3],
      [2, 4],
      [5, 7],
      [6, 8],
      [1, 4],
      [2, 3],
      [5, 8],
      [6, 7],
    ]) {
      expect(pair(a1(a), a1(b), wide)).toBe("degraded");
      expect(pair(a1(b), a1(a), wide)).toBe("degraded");
      // 面对面/斜对角必须严格劣于所有“能看见屏幕”的关系。
      expect(GRADE_RANK.degraded).toBeGreaterThan(GRADE_RANK.excellent);
      expect(GRADE_RANK.degraded).toBeGreaterThan(GRADE_RANK.good);
      expect(GRADE_RANK.degraded).toBeGreaterThan(GRADE_RANK.fair);
    }
  });
  it("隔桌、跨桌近对近/远对远都不构成相邻", () => {
    // 3 5 是相邻桌角对角（good），不在本列；这里只放真正配不上的组合。
    for (const [a, b] of [
      [1, 7],
      [1, 8],
      [2, 5],
      [3, 8],
      [1, 9],
      [2, 7],
      [6, 9],
      [1, 5],
      [2, 6],
    ])
      expect(pair(a1(a), a1(b), wide)).toBe("none");
  });
  it("默认 section1End=8 时只有 1..7 属区域一", () => {
    expect(deviceArea(a1(7), defaults)).toBe(1);
    expect(deviceArea(a1(8), defaults)).toBeNull();
    // 1..7 = 桌0 的 1 2 3 4 与桌1 的 5 6 7（8 越界）。
    expect(pair(a1(3), a1(4))).toBe("excellent");
    expect(pair(a1(3), a1(5))).toBe("good");
  });
  it("自定义 section1Start 平移区域一，不改任何相对关系", () => {
    // 现场可把区域一改成 11..26：起点平移后 11 12 仍肩并肩、11 13 仍面对面。
    const shifted = withSettings({ section1Start: 11, section1End: 16 });
    expect(deviceArea(a1(10), shifted)).toBeNull();
    expect(deviceArea(a1(11), shifted)).toBe(1);
    expect(deviceCells(a1(11), shifted)[0]).toMatchObject({ area: 1, pos: 1 });
    expect(deviceArea(a1(25), shifted)).toBe(1);
    expect(deviceArea(a1(26), shifted)).toBeNull();
    expect(pair(a1(11), a1(12), shifted)).toBe("excellent");
    expect(pair(a1(11), a1(13), shifted)).toBe("degraded");
    expect(pair(a1(13), a1(15), shifted)).toBe("good");
    // section1End 仍是“绝对宽度”，起点平移不改变它。
    expect(pair(a1(11), a1(12), defaults)).toBe("none");
  });
});

describe("S-U 相邻几何：区域二长排", () => {
  it("同排相邻 = excellent（肩并肩，长排排在一起最好）", () => {
    expect(pair(a2(31), a2(33))).toBe("excellent");
    expect(pair(a2(33), a2(35))).toBe("excellent");
    expect(pair(a2(32), a2(34))).toBe("excellent");
  });
  it("长桌中间被占用可以跳过：隔一个空位 = fair", () => {
    // 用户原话：“如果只是长桌中间有一个人用了可以跳过”。
    expect(pair(a2(31), a2(35))).toBe("fair");
    expect(pair(a2(32), a2(36))).toBe("fair");
  });
  it("绕到对面 / 隔空档正对 = degraded（看不见对方屏幕）", () => {
    // 用户原话：“长桌的两侧要绕到对面很差”。
    expect(pair(a2(31), a2(32))).toBe("degraded");
    expect(pair(a2(33), a2(34))).toBe("degraded");
    expect(pair(a2(31), a2(34))).toBe("degraded");
    expect(pair(a2(33), a2(36))).toBe("degraded");
  });
  it("同排隔两位以上不相邻", () => {
    expect(pair(a2(31), a2(37))).toBe("none");
  });
  it("自定义 section2Start 平移两排，不改列号判定", () => {
    const shifted = withSettings({ section2Start: 51 });
    expect(deviceArea(a2(50), shifted)).toBeNull();
    expect(deviceCells(a2(51), shifted)[1]).toMatchObject({
      area: 2,
      pos: 1,
    });
    expect(pair(a2(51), a2(53), shifted)).toBe("excellent");
    expect(pair(a2(51), a2(55), shifted)).toBe("fair");
    expect(pair(a2(51), a2(52), shifted)).toBe("degraded");
    // 默认起点 31 时 51 仍是区域二，但列号不同。
    expect(pair(a2(51), a2(53), defaults)).toBe("excellent");
  });
});

describe("S-U 相邻几何：区域三四人桌与 S3 边界", () => {
  // section3Start=41 ⇒ 41 42 43 44 是桌0、45 46 47 48 是桌1。
  it("并排、面对面、背对背、斜对角与区域一同一套几何", () => {
    expect(pair(a3(41), a3(42))).toBe("excellent");
    expect(pair(a3(43), a3(44))).toBe("excellent");
    expect(pair(a3(45), a3(46))).toBe("excellent");
    expect(pair(a3(41), a3(43))).toBe("degraded");
    expect(pair(a3(42), a3(44))).toBe("degraded");
    expect(pair(a3(45), a3(47))).toBe("degraded");
    expect(pair(a3(43), a3(45))).toBe("good");
    expect(pair(a3(44), a3(46))).toBe("good");
    expect(pair(a3(41), a3(44))).toBe("degraded");
    expect(pair(a3(42), a3(43))).toBe("degraded");
    expect(pair(a3(41), a3(49))).toBe("none");
  });
  it("section3Start=45 时 41 不再是区域三", () => {
    const later = withSettings({ section3Start: 45 });
    expect(pair(a3(41), a3(45), later)).toBe("none");
    expect(deviceArea(a3(41), later)).toBeNull();
    expect(pair(a3(45), a3(46), later)).toBe("excellent");
    expect(pair(a3(47), a3(49), later)).toBe("good");
  });
});

describe("S-U 相邻几何：跨区域策略", () => {
  const left = a1(1);
  const right = a2(31);
  it("allowCrossArea=false 降为 none", () => {
    expect(
      adjacencyGradeOf(left, right, withSettings({ allowCrossArea: false })),
    ).toBe("none");
  });
  it("allowCrossArea=true 上限为 good", () => {
    expect(
      adjacencyGradeOf(left, right, withSettings({ allowCrossArea: true })),
    ).toBe("good");
  });
});

describe("S-U 座位规划", () => {
  const eight = ["1-0-0", "2-0-0", "3-0-0", "4-0-0", "5-0-0", "6-0-0", "7-0-0"];
  const wide = withSettings({ section1End: 16 });

  it("两人优先选同一短边并排（excellent），而不是斜对角", () => {
    const plan = planSeats(eight, 2, wide)!;
    expect(plan.grade).toBe("excellent");
    expect(plan.codes).toEqual(["1-0-0", "2-0-0"]);
    // 斜对角只在没有更好选择时才会出现。
    const onlyDiagonal = planSeats(["1-0-0", "4-0-0"], 2, wide)!;
    expect(onlyDiagonal.grade).toBe("degraded");
    expect(ADJACENCY_GRADES.indexOf(plan.grade)).toBeLessThan(
      ADJACENCY_GRADES.indexOf(onlyDiagonal.grade),
    );
  });
  it("四人优先取两张相邻桌的角对角（3 4 5 6），而不是整桌面对面", () => {
    // 用户原话：“人 ≤ 4 这类就直接放在两张桌子的能看到对方屏幕的地方，
    // 例如 3 4 5 6”。3 4 与 5 6 各自肩并肩（excellent），
    // 3 5 / 4 6 是相邻桌角对角（good）⇒ 整批 good；
    // 而整桌 1 2 3 4 含面对面 1 3 / 2 4 与斜对角 1 4 / 2 3 ⇒ degraded。
    const plan = planSeats(eight, 4, wide)!;
    expect(plan.codes).toEqual(["3-0-0", "4-0-0", "5-0-0", "6-0-0"]);
    expect(plan.grade).toBe("good");
    const wholeDesk = scoreArrangement(
      ["1-0-0", "2-0-0", "3-0-0", "4-0-0"],
      wide,
    );
    expect(wholeDesk.grade).toBe("degraded");
    expect(ADJACENCY_GRADES.indexOf(plan.grade)).toBeLessThan(
      ADJACENCY_GRADES.indexOf(wholeDesk.grade),
    );
  });
  it("count 大于候选数、重复编号、非法 count 返回 null", () => {
    expect(planSeats(eight, 99, wide)).toBeNull();
    expect(planSeats(["1-0-0", "1-0-0"], 2, wide)).toBeNull();
    expect(planSeats(eight, 0, wide)).toBeNull();
    expect(planSeats(eight, -1, wide)).toBeNull();
    expect(planSeats(eight, 1.5, wide)).toBeNull();
    expect(planSeats([], 1, wide)).toBeNull();
  });
  it("确定性：同输入多次调用结果完全一致，候选顺序不影响选择", () => {
    const once = planSeats(eight, 2, wide);
    for (let index = 0; index < 5; index += 1)
      expect(planSeats(eight, 2, wide)).toEqual(once);
    expect(planSeats([...eight].reverse(), 2, wide)!.codes).toEqual(
      once!.codes,
    );
  });
  it("order 指向输入 codes 下标", () => {
    const plan = planSeats(eight, 3, wide)!;
    expect(plan.order).toHaveLength(3);
    for (const [slot, index] of plan.order.entries())
      expect(plan.codes[slot]).toBe(eight[index]);
    expect(new Set(plan.order).size).toBe(3);
  });
  it("中文标签与等级秩", () => {
    const plan = planSeats(eight, 1, wide)!;
    expect(plan.codes).toHaveLength(1);
    for (const grade of ADJACENCY_GRADES)
      expect(GRADE_LABELS[grade]).toBeTruthy();
    expect(ADJACENCY_GRADES).toHaveLength(6);
    // 界面展示用的标签保持短，避免在刷卡窗口的左栏被截断。
    expect(GRADE_LABELS.excellent).toBe("完全相邻");
    expect(GRADE_LABELS.good).toBe("较优相邻");
    expect(GRADE_LABELS.fair).toBe("次优相邻");
    expect(GRADE_LABELS.degraded).toBe("勉强相邻");
    expect(GRADE_RANK.degraded).toBe(3);
    expect(GRADE_RANK.clustered).toBe(4);
    expect(GRADE_RANK.degraded).toBeLessThan(GRADE_RANK.clustered);
    expect(GRADE_RANK.clustered).toBeLessThan(GRADE_RANK.scattered);
  });
  it("候选里混入几何未知编号时不崩溃", () => {
    const plan = planSeats(["A-01", "1-0-0", "2-0-0"], 2, defaults);
    expect(plan).not.toBeNull();
    expect(plan!.codes).toEqual(["1-0-0", "2-0-0"]);
    expect(plan!.grade).toBe("excellent");
  });
});

describe("S-U 评分与跨度", () => {
  const wide = withSettings({ section1End: 16 });
  it("同一短边并排为 excellent，span 为两角序号极差", () => {
    expect(scoreArrangement([a1(1), a1(2)], wide)).toEqual({
      grade: "excellent",
      span: 1,
      crossArea: false,
      run: 1,
    });
    expect(spanOf([a1(1), a1(2)], wide)).toBe(1);
  });
  it("含斜对角的方案落到 degraded，且 degraded 优于 clustered", () => {
    const diagonal = scoreArrangement([a1(1), a1(4)], wide);
    expect(diagonal.grade).toBe("degraded");
    expect(GRADE_RANK.degraded).toBeLessThan(GRADE_RANK.clustered);
    const far = scoreArrangement([a2(31), a2(61)], defaults);
    expect(far.grade).toBe("clustered");
    expect(GRADE_RANK.degraded).toBeLessThan(GRADE_RANK.clustered);
  });
  it("clustered 用 span 衡量集中度", () => {
    // 38 与 31 隔了三位以上，同排不相邻（gap ≥ 3）⇒ clustered。
    const near = scoreArrangement([a2(31), a2(37)], defaults);
    const far = scoreArrangement([a2(31), a2(61)], defaults);
    expect(near.grade).toBe("clustered");
    expect(far.grade).toBe("clustered");
    expect(near.span).toBeLessThan(far.span);
  });
  it("跨区域方案被压到 degraded 并标注 crossArea", () => {
    const mixed = scoreArrangement([a1(1), a2(31)], defaults);
    expect(mixed.crossArea).toBe(true);
    // §2 同房间约束：跨区域封顶到 degraded（即使几何上是 good）。
    expect(mixed.grade).toBe("degraded");
    const forbiddenSettings = withSettings({ allowCrossArea: false });
    const forbidden = scoreArrangement([a1(1), a2(31)], forbiddenSettings);
    expect(forbidden.crossArea).toBe(true);
    expect(ADJACENCY_GRADES.indexOf(forbidden.grade)).toBeGreaterThanOrEqual(
      ADJACENCY_GRADES.indexOf("degraded"),
    );
    const plan = planSeats(
      [a1(1), a1(2), a2(31), a2(32)],
      2,
      forbiddenSettings,
    )!;
    expect(plan.crossArea).toBe(false);
  });
  it("spanOf 按区域分别累计极差", () => {
    expect(spanOf([a3(41), a3(45)], defaults)).toBe(4);
    expect(
      spanOf([a1(1), a1(3), a2(31), a2(33), a3(41), a3(43)], defaults),
    ).toBe(2 + 2 + 2);
    expect(spanOf([a1(1)], defaults)).toBe(0);
    expect(spanOf(["A-01"], defaults)).toBe(0);
  });
});

describe("S-U 布局设置校验", () => {
  it("默认值合法且边界被接受", () => {
    expect(layoutSettingsSchema.safeParse(defaults).success).toBe(true);
    expect(
      layoutSettingsSchema.safeParse({
        ...defaults,
        section1End: 96,
        // 9960 不满足 (x − 41) % 4 === 0；≤ 9960 的最大网格值是 9957。
        section3Start: 9957,
        batchWindowSec: 10,
        batchStudentLimit: 2,
      }).success,
    ).toBe(true);
    expect(
      layoutSettingsSchema.safeParse({
        ...defaults,
        section1End: 8,
        section3Start: 45,
        batchWindowSec: 600,
        batchStudentLimit: 12,
      }).success,
    ).toBe(true);
  });
  it("非法取值拒绝", () => {
    for (const patch of [
      // S1 必须是 ≥ 8 的 4 的倍数：4 只够三个角、5/6 不是倍数、100 越界。
      { section1End: 1 },
      { section1End: 4 },
      { section1End: 5 },
      { section1End: 6 },
      { section1End: 100 },
      { section1End: 3 },
      // S3 必须落在四角桌起点网格 (x − 41) % 4 === 0：42/43/44/40 非法、9962 越界。
      { section3Start: 40 },
      { section3Start: 42 },
      { section3Start: 43 },
      { section3Start: 44 },
      { section3Start: 9962 },
      { batchWindowSec: 9 },
      { batchWindowSec: 601 },
      { batchStudentLimit: 1 },
      { batchStudentLimit: 13 },
      { allowCrossArea: "yes" },
      { section1End: 4.5 },
    ])
      expect(
        layoutSettingsSchema.safeParse({ ...defaults, ...patch }).success,
      ).toBe(false);
  });
  it("section3Start 只接受 (x − 41) % 4 === 0 的四角桌起点", () => {
    for (const value of [41, 45, 49, 53, 9957])
      expect(
        layoutSettingsSchema.safeParse({ ...defaults, section3Start: value })
          .success,
      ).toBe(true);
    for (const value of [42, 43, 44, 46, 47, 9960])
      expect(
        layoutSettingsSchema.safeParse({ ...defaults, section3Start: value })
          .success,
      ).toBe(false);
  });
  it("section1Start / section2Start 的取值边界", () => {
    for (const value of [1, 11, 1000])
      expect(
        layoutSettingsSchema.safeParse({ ...defaults, section1Start: value })
          .success,
      ).toBe(true);
    for (const value of [0, -1, 1001, 1.5])
      expect(
        layoutSettingsSchema.safeParse({ ...defaults, section1Start: value })
          .success,
      ).toBe(false);
    for (const value of [2, 31, 51, 1000])
      expect(
        layoutSettingsSchema.safeParse({ ...defaults, section2Start: value })
          .success,
      ).toBe(true);
    for (const value of [0, 1, -3, 1001, 2.5])
      expect(
        layoutSettingsSchema.safeParse({ ...defaults, section2Start: value })
          .success,
      ).toBe(false);
  });
  it("自定义起点 + 全量 layoutUpdate 可用", () => {
    const shifted = {
      ...defaults,
      section1Start: 11,
      section2Start: 51,
    };
    expect(layoutSettingsSchema.safeParse(shifted).success).toBe(true);
    expect(
      layoutUpdateSchema.safeParse({
        ...shifted,
        requestId: "00000000-0000-4000-8000-000000000000",
        expectedVersion: 1,
      }).success,
    ).toBe(true);
  });
  it("section1End 必须是 ≥ 8 的 4 的倍数", () => {
    for (const value of [8, 12, 16, 96])
      expect(
        layoutSettingsSchema.safeParse({ ...defaults, section1End: value })
          .success,
      ).toBe(true);
    for (const value of [4, 6, 10, 100])
      expect(
        layoutSettingsSchema.safeParse({ ...defaults, section1End: value })
          .success,
      ).toBe(false);
  });
  it("layoutUpdateSchema 要求 requestId/expectedVersion 且拒绝未知字段", () => {
    const ok = {
      ...defaults,
      requestId: "00000000-0000-4000-8000-000000000000",
      expectedVersion: 1,
    };
    expect(layoutUpdateSchema.safeParse(ok).success).toBe(true);
    expect(layoutUpdateSchema.safeParse({ ...ok, extra: 1 }).success).toBe(
      false,
    );
    expect(
      layoutUpdateSchema.safeParse({ ...ok, expectedVersion: 0 }).success,
    ).toBe(false);
    expect(
      layoutUpdateSchema.safeParse({ ...ok, requestId: "x" }).success,
    ).toBe(false);
    expect(
      layoutUpdateSchema.safeParse({ ...ok, section1End: 5 }).success,
    ).toBe(false);
  });
  it("批次与试验组 schema", () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect(batchCloseSchema.safeParse({ requestId: id }).success).toBe(true);
    expect(batchCloseSchema.safeParse({ requestId: id, x: 1 }).success).toBe(
      false,
    );
    expect(batchAssignConfirmSchema.safeParse({ requestId: id }).success).toBe(
      true,
    );
    expect(
      experimentToggleSchema.safeParse({ requestId: id, enabled: true })
        .success,
    ).toBe(true);
    expect(experimentToggleSchema.safeParse({ requestId: id }).success).toBe(
      false,
    );
    expect(experimentListSchema.parse({})).toEqual({ page: 1, pageSize: 30 });
    expect(
      experimentListSchema.parse({ page: "2", pageSize: "50", search: "张" }),
    ).toEqual({
      page: 2,
      pageSize: 50,
      search: "张",
    });
    expect(
      experimentListSchema.safeParse({ search: "x".repeat(101) }).success,
    ).toBe(false);
    expect(experimentListSchema.safeParse({ pageSize: 101 }).success).toBe(
      false,
    );
    expect(experimentListSchema.safeParse({ page: 0 }).success).toBe(false);
    expect(batchJoinSchema).toBe(scanSchema);
  });
});

describe("S-U 座位规划：规模与剪枝", () => {
  it("12 人、160 候选在有界时间内完成且结果确定", () => {
    const candidates: string[] = [];
    for (let table = 0; table < 40; table += 1)
      for (let corner = 0; corner < 4; corner += 1)
        candidates.push(`${table * 4 + corner + 1}-0-0`);
    const settings = withSettings({ section1End: 96, batchStudentLimit: 12 });
    expect(candidates).toHaveLength(160);
    const started = Date.now();
    const plan = planSeats(candidates, 12, settings);
    const spent = Date.now() - started;
    expect(plan).not.toBeNull();
    expect(plan!.codes).toHaveLength(12);
    // 搜索预算是硬上限，保证最差情况也在 2 秒内返回。
    expect(spent).toBeLessThan(2000);
    expect(planSeats(candidates, 12, settings)).toEqual(plan);
    expect(ADJACENCY_GRADES).toContain(plan!.grade);
  });
  it("8 人的常见批次规模能在毫秒级内得到相邻解", () => {
    const candidates: string[] = [];
    for (let table = 0; table < 8; table += 1)
      for (let corner = 0; corner < 4; corner += 1)
        candidates.push(`${table * 4 + corner + 1}-0-0`);
    const settings = withSettings({ section1End: 96, batchStudentLimit: 12 });
    const started = Date.now();
    const plan = planSeats(candidates, 8, settings)!;
    expect(Date.now() - started).toBeLessThan(500);
    expect(plan.codes).toHaveLength(8);
    // 8 人坐满两张四人桌时，跨桌存在大量配不上的组合（1 与 5、3 与 7 等），
    // 整组已经不算“相邻”，服务端按 §2 落到 clustered 并用 span 度量集中度。
    expect(plan.grade).toBe("clustered");
    // 在有解的小规模上，规划器优先给出 good（两对肩并肩 + 相邻桌角对角）
    // 而不是含面对面的 degraded。
    const four = planSeats(
      ["1-0-0", "2-0-0", "3-0-0", "4-0-0", "5-0-0", "6-0-0"],
      4,
      settings,
    )!;
    expect(four.grade).toBe("good");
    expect(four.codes).toEqual(["3-0-0", "4-0-0", "5-0-0", "6-0-0"]);
    expect(plan.span).toBeGreaterThan(0);
  });
  it("无相邻解时退到 clustered 并给出最小 span", () => {
    // 区域二同排隔三位以上才不相邻（gap = 2 仍是 fair 的长桌跳过）。
    // 31 与 47：列号 0 与 8 相差 8 ⇒ none；单独两台即是 clustered。
    const scattered = ["0-31-0", "0-47-0"];
    const plan = planSeats(scattered, 2, defaults)!;
    expect(plan.grade).toBe("clustered");
    expect(plan.codes).toEqual(["0-31-0", "0-47-0"]);
    expect(plan.span).toBe(16);
    // 混入一组可相邻的候选时，规划器优先取能看见屏幕的相邻解。
    const mixed = planSeats(
      ["0-31-0", "0-47-0", "0-61-0", "0-63-0"],
      2,
      defaults,
    )!;
    expect(ADJACENCY_GRADES.indexOf(mixed.grade)).toBeLessThan(
      ADJACENCY_GRADES.indexOf("clustered"),
    );
  });
});

describe("设备名里提取座位号（resolveSeat / seatNumberFromName）", () => {
  const s = DEFAULT_LAYOUT_SETTINGS;
  it("三段式取主段，描述性名字取最后一段数字", () => {
    expect(seatNumberFromName("3-21-43")).toBe(3);
    expect(seatNumberFromName("0-31-0")).toBe(31);
    expect(seatNumberFromName("图书馆A区第3排 6 号机")).toBe(6);
    expect(seatNumberFromName("二楼东侧 33 号")).toBe(33);
  });
  it("没有数字 / 空串 / 0 号都返回 null", () => {
    expect(seatNumberFromName("")).toBeNull();
    expect(seatNumberFromName("   ")).toBeNull();
    expect(seatNumberFromName("未命名机位")).toBeNull();
    expect(seatNumberFromName("0 号")).toBeNull();
  });
  it("resolveSeat 按座位号判定区域", () => {
    expect(resolveSeat("图书馆A区第3排 6 号机", s)).toMatchObject({
      area: 1,
      pos: 6,
    });
    expect(resolveSeat("二楼东侧 33 号", s)).toMatchObject({ area: 2 });
    expect(resolveSeat("未命名机位", s)).toBeNull();
  });
  it("名字形态的三台设备同样能判出相邻关系", () => {
    expect(adjacencyGradeOf("A区 3 号机", "A区 4 号机", s)).toBe("excellent");
    expect(adjacencyGradeOf("A区 3 号机", "A区 5 号机", s)).toBe("good");
    expect(adjacencyGradeOf("A区 1 号机", "A区 3 号机", s)).toBe("degraded");
    expect(adjacencyGradeOf("东侧 31 号", "东侧 33 号", s)).toBe("excellent");
    expect(adjacencyGradeOf("东侧 31 号", "东侧 32 号", s)).toBe("degraded");
  });
  it("三段式行为不回归", () => {
    expect(adjacencyGradeOf("1-0-0", "2-0-0", s)).toBe("excellent");
    expect(adjacencyGradeOf("1-0-0", "3-0-0", s)).toBe("degraded");
    expect(deviceArea("0-31-0", s)).toBe(2);
  });
});

describe("S-U 长排连坐优先（用户要求：三个人直接尽量排在长桌上）", () => {
  const long = Array.from(
    { length: 8 },
    (_, index) => `0-${DEFAULT_LAYOUT_SETTINGS.section2Start + 2 * index}-0`,
  );
  const desks = ["1-0-0", "2-0-0", "3-0-0", "4-0-0", "5-0-0", "6-0-0", "7-0-0"];

  it("三人优先排成一整段长排，且整批算 excellent", () => {
    const plan = planSeats(long, 3, defaults)!;
    expect(plan.codes).toEqual([long[0], long[1], long[2]]);
    expect(plan.grade).toBe("excellent");
    expect(plan.run).toBe(3);
    // 同一条长排上连着坐，即使 31 与 35 中间隔着 33，整批仍是最好的等级。
    expect(runOf(plan.codes, defaults)).toBe(3);
  });

  it("四人、五人继续延长长排仍是 excellent，不会被面对面拖低", () => {
    for (const count of [4, 5]) {
      const plan = planSeats(long, count, defaults)!;
      expect(plan.codes).toEqual(long.slice(0, count));
      expect(plan.grade).toBe("excellent");
      expect(plan.run).toBe(count);
    }
  });

  it("长排与四人桌都在候选里时，三人仍选长排", () => {
    const plan = planSeats([...desks, ...long], 3, defaults)!;
    const areas = plan.codes.map((code) => deviceArea(code, defaults));
    expect(areas.every((area) => area === 2)).toBe(true);
    expect(plan.grade).toBe("excellent");
    expect(plan.run).toBe(3);
    // 对照组：只有四人桌可选时，三人只能退到 good（并排 + 跨桌角对角）。
    const deskOnly = planSeats(desks, 3, withSettings({ section1End: 16 }))!;
    expect(GRADE_RANK[plan.grade]).toBeLessThan(GRADE_RANK[deskOnly.grade]);
  });

  it("长排不够长时逐级退化：剩余座位仍成段就继续用满", () => {
    const short = long.slice(0, 2);
    const plan = planSeats(short, 2, defaults)!;
    expect(plan.grade).toBe("excellent");
    expect(plan.run).toBe(2);
  });

  it("runOf 的语义：同排连续计数，隔一个不在方案里的座位不算断裂", () => {
    expect(runOf([long[0], long[1], long[2]], defaults)).toBe(3);
    // 中间跳过 long[1] 时，31 与 35 只构成 run=1 的两段（方案里没有 33）。
    expect(runOf([long[0], long[2]], defaults)).toBe(1);
  });
});

describe("S-U 干扰设备不得破坏整排最优解（回归）", () => {
  const row = Array.from(
    { length: 8 },
    (_, index) => `0-${DEFAULT_LAYOUT_SETTINGS.section2Start + 2 * index}-0`,
  );
  const intruder = "1-0-0";

  it("候选里混入其他区域设备时，2..8 人仍必须坐成一整排", () => {
    for (let count = 2; count <= 8; count += 1) {
      const plan = planSeats(
        [intruder, ...row.slice(0, count)],
        count,
        defaults,
      )!;
      expect({ count, grade: plan.grade, run: plan.run }).toEqual({
        count,
        grade: "excellent",
        run: count,
      });
      // 整排方案里不应出现干扰设备。
      expect(plan.codes).not.toContain(intruder);
    }
  });

  it("穷举校验：planSeats 的结果不劣于手工枚举的最优等级", () => {
    const candidates = [intruder, ...row.slice(0, 4)];
    const combinations = (arr: string[], size: number): string[][] => {
      if (size === 0) return [[]];
      return arr.flatMap((head, index) =>
        combinations(arr.slice(index + 1), size - 1).map((rest) => [
          head,
          ...rest,
        ]),
      );
    };
    for (let count = 2; count <= 4; count += 1) {
      const best = combinations(candidates, count)
        .map((subset) => scoreArrangement(subset, defaults))
        .reduce((left, right) =>
          GRADE_RANK[left.grade] < GRADE_RANK[right.grade] ||
          (GRADE_RANK[left.grade] === GRADE_RANK[right.grade] &&
            left.run > right.run)
            ? left
            : right,
        );
      const plan = planSeats(candidates, count, defaults)!;
      expect(GRADE_RANK[plan.grade]).toBeLessThanOrEqual(
        GRADE_RANK[best.grade],
      );
      if (plan.grade === best.grade)
        expect(plan.run).toBeGreaterThanOrEqual(best.run);
    }
  });
});
