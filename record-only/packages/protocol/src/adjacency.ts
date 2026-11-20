/**
 * 相邻试验组的设备编号几何、评分与座位规划（纯函数，无副作用、无 IO、不抛异常）。
 *
 * 契约来源：docs/adjacent-layout.md（实现冻结稿）。
 *
 * 本文件是全仓唯一的一份算法实现。放在 `@record/protocol` 而不是
 * `@record/domain`，是因为它只依赖纯类型：教师端 renderer（electron-vite）
 * 需要 `GRADE_LABELS` / `parseDeviceCode` 等做实时预览，而 `@record/domain`
 * 含 `node:crypto`（payloadDigest），在 renderer 里会被 externalize 成
 * `__vite-browser-external` 而打包失败。
 * **因此本文件禁止 import 任何 `node:*` 或依赖 Node API 的模块。**
 */

/** 相邻试验组评分等级，数组顺序即优先序（索引小者更优）。 */
export const ADJACENCY_GRADES = [
  "excellent",
  "good",
  "fair",
  "degraded",
  "clustered",
  "scattered",
] as const;
export type AdjacencyGrade =
  | "excellent"
  | "good"
  | "fair"
  | "degraded"
  | "clustered"
  | "scattered";
/** 两个座位之间的关系（无向）；"none" 表示不构成任何相邻关系。 */
export type AdjacencyRelation =
  | "excellent"
  | "good"
  | "fair"
  | "degraded"
  | "none";

/** docs/adjacent-layout.md §4：布局与批次设置。 */
export interface LayoutSettings {
  /**
   * 区域一的第一个编号，默认 1。区域一占
   * `[section1Start, section1Start + section1End − 1)`，即 `section1End`
   * 仍表示“**绝对**边界宽度”，换起点时不改变它的语义。
   */
  section1Start: number;
  /** 区域一的边界宽度（桌数 × 4）：4 的倍数且 8 ≤ x ≤ 96。 */
  section1End: number;
  /**
   * 区域二的第一个编号，默认 31。两排长桌从同一个起点编号：
   * `section2Start` 与 `section2Start + 1` 正对，`+2` 与起点同排在下一列。
   */
  section2Start: number;
  /** 区域三起点 S3：41 ≤ S3 ≤ 9960 且 (S3 − 41) % 4 === 0。 */
  section3Start: number;
  /** 允许跨区域分配（false 时跨区域相邻降级为不相邻）。 */
  allowCrossArea: boolean;
  /** 批次收集窗口 10–600 秒。 */
  batchWindowSec: number;
  /** 单批人数上限 2–12。 */
  batchStudentLimit: number;
}

/** §4 的 section1Start 约束：区域一的第一个编号，1 ≤ x ≤ 1000。 */
export function isValidSection1Start(x: number): boolean {
  return Number.isInteger(x) && x >= 1 && x <= 1000;
}

/** §4 的 section2Start 约束：区域二的第一个编号，2 ≤ x ≤ 1000。 */
export function isValidSection2Start(x: number): boolean {
  return Number.isInteger(x) && x >= 2 && x <= 1000;
}

/** §4 的 section1End 约束：4 的倍数且 8 ≤ x ≤ 96（至少两张完整四角桌）。 */
export function isValidSection1End(x: number): boolean {
  return Number.isInteger(x) && x >= 8 && x <= 96 && x % 4 === 0;
}

/**
 * §4 的 section3Start 约束：41 ≤ x ≤ 9960 且 (x − 41) % 4 === 0
 * （四角桌起点网格 41、45、49…，保证区域三从完整桌子的第一个角开始）。
 */
export function isValidSection3Start(x: number): boolean {
  return Number.isInteger(x) && x >= 41 && x <= 9960 && (x - 41) % 4 === 0;
}

/** 编号解析结果：三个段落值。 */
export interface ParsedDeviceCode {
  a: number;
  b: number;
  c: number;
}

/** 单个段落落在哪个区域、区域内的 1 基位置。 */
export interface DeviceSegment {
  segment: 1 | 2 | 3;
  value: number;
  area: 1 | 2 | 3;
  /**
   * docs §1.1 的 pos（1 基，pos=1 为该区域第一个角）：
   * 区域一 pos = v；区域三 pos = v − section3Start + 1；区域二 pos = v。
   */
  pos: number;
}

/** 段落描述三元组；段不属于任何区域时该段为 null。 */
export type DeviceCells = [
  DeviceSegment | null,
  DeviceSegment | null,
  DeviceSegment | null,
];

export const GRADE_LABELS: Record<AdjacencyGrade, string> = {
  excellent: "完全相邻",
  good: "较优相邻",
  fair: "次优相邻",
  degraded: "勉强相邻",
  clustered: "集中安排",
  scattered: "分散安排",
};

export const GRADE_RANK: Record<AdjacencyGrade, number> = {
  excellent: 0,
  good: 1,
  fair: 2,
  degraded: 3,
  clustered: 4,
  scattered: 5,
};

/** 关系等级：与 GRADE_RANK 的前四档对齐，`none` 永远最差。 */
const RELATION_RANK: Record<AdjacencyRelation, number> = {
  excellent: 0,
  good: 1,
  fair: 2,
  degraded: 3,
  none: 4,
};

/** 关系数组：下标即 RELATION_RANK，`none` 在最末。 */
const RELATIONS: readonly AdjacencyRelation[] = [
  "excellent",
  "good",
  "fair",
  "degraded",
  "none",
];
const NONE_RANK = RELATION_RANK.none;
const DEGRADED_RANK = RELATION_RANK.degraded;

/** 由关系秩得到方案等级：最差关系为 none 时说明“配不上”，交给 clustered。 */
function gradeOfRank(rank: number): AdjacencyGrade {
  return rank >= NONE_RANK ? "clustered" : (RELATIONS[rank] as AdjacencyGrade);
}

const MIN_VALUE = 0;
const MAX_VALUE = 99999;

/** 区域二用“奇偶两条长排”：奇数一上排、偶数一下排，从同一端起算列号。 */
const SECTION2_ODD = 1;
const SECTION2_EVEN = 0;

function isSettings(value: unknown): value is LayoutSettings {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<LayoutSettings>;
  return (
    Number.isFinite(v.section1Start) &&
    Number.isFinite(v.section1End) &&
    Number.isFinite(v.section2Start) &&
    Number.isFinite(v.section3Start) &&
    Number.isFinite(v.batchWindowSec) &&
    Number.isFinite(v.batchStudentLimit) &&
    typeof v.allowCrossArea === "boolean"
  );
}

/**
 * 解析形如 `1-21-41` 的设备编号：恰好三段，连接符为任意非数字串，
 * 每段 0..99999，首尾无空段。
 */
export function parseDeviceCode(code: string): ParsedDeviceCode | null {
  if (typeof code !== "string") return null;
  const trimmed = code.trim();
  if (trimmed === "") return null;
  // 连接符是“任意非数字串”，但不得出现空段：首尾空段与连续连接符都非法。
  if (/^\D/.test(trimmed) || /\D$/.test(trimmed) || /\D{2,}/.test(trimmed))
    return null;
  const parts = trimmed.split(/\D/);
  if (parts.length !== 3) return null;
  const values: number[] = [];
  for (const part of parts) {
    if (part === "" || !/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isSafeInteger(value) || value < MIN_VALUE || value > MAX_VALUE)
      return null;
    values.push(value);
  }
  return { a: values[0]!, b: values[1]!, c: values[2]! };
}

/**
 * 段落归属（docs §1）：第 1 段只描述区域一，第 2 段只描述区域二，
 * 第 3 段只描述区域三。段值落在本区域范围之外（例如某区域的编号小于
 * `section3Start`）时该段为“无归属”，不会被误判成别的区域。
 */
function areaOf(
  segment: 1 | 2 | 3,
  value: number,
  settings: LayoutSettings,
): 1 | 2 | 3 | null {
  if (segment === 1) {
    // 区域一占 [start, start + end − 1)：section1End 仍是“绝对宽度”，
    // 默认 start=1、end=8 ⇒ 1..7，与旧语义完全一致。
    const start = settings.section1Start;
    return value >= start && value < start + settings.section1End - 1
      ? 1
      : null;
  }
  if (segment === 2) return value >= settings.section2Start ? 2 : null;
  return value >= settings.section3Start ? 3 : null;
}

function segmentCell(
  segment: 1 | 2 | 3,
  value: number,
  settings: LayoutSettings,
): DeviceSegment | null {
  const area = areaOf(segment, value, settings);
  if (area === null) return null;
  /**
   * docs §1.1 的 pos 是 1 基（pos=1 为该区域第一个角）：各区域都用
   * “编号 − 本区域起点 + 1”，于是改起点不会改变任何相邻判定。
   * 区域二另用 `rowOf` 按 section2Start 换算列号，pos 只用于 span/排序。
   */
  const pos =
    area === 1
      ? value - settings.section1Start + 1
      : area === 3
        ? value - settings.section3Start + 1
        : value - settings.section2Start + 1;
  return { segment, value, area, pos };
}

/** 每段对应区域描述；段无归属时该段为 null；非法编号返回全 null。 */
/**
 * 从设备名 / 编号里提取**座位号**。
 *
 * 现场设备名是描述性的（例如“图书馆A区第3排 6 号机”），里面只有一段固定位置
 * 的数字是座位号；早期数据也可能直接是三段式编号（`3-21-43`）。两种都要支持：
 *
 * - 形如 `1-21-43` 的三段式：返回**主段**（第一个非 0 的段），保持向后兼容；
 * - 其他字符串：取**最后一段连续数字**（`/\d+/g` 的最后一个）；
 * - 结果必须在 `1..99999`，否则视为没有座位号。
 */
export function seatNumberFromName(name: string): number | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed === "") return null;
  const three = parseDeviceCode(trimmed);
  if (three) {
    for (const value of [three.a, three.b, three.c])
      if (value > 0) return value;
    return null;
  }
  const matches = trimmed.match(/\d+/g);
  if (!matches?.length) return null;
  const value = Number(matches[matches.length - 1]);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_VALUE)
    return null;
  return value;
}

/**
 * 解析缓存：`planSeats` 会对 n 个候选两两建关系矩阵（O(n²) 次解析），
 * 而解析本身要跑三段式正则或座位号抽取，160 候选时会占掉大部分时间。
 * 纯函数 + 不可变输入，按“编号 + 布局设置签名”缓存即可，命中率高、无失效问题。
 */
const CELL_CACHE_LIMIT = 20_000;
const cellCache = new Map<string, DeviceCells>();

function settingsKey(settings: LayoutSettings): string {
  return `${settings.section1Start},${settings.section1End},${settings.section2Start},${settings.section3Start}`;
}

/** 清空解析缓存（仅测试与布局热更新用；正常调用不需要）。 */
export function clearAdjacencyCache(): void {
  cellCache.clear();
}

export function deviceCells(
  code: string,
  settings: LayoutSettings,
): DeviceCells {
  if (!isSettings(settings)) return [null, null, null];
  const key = `${settingsKey(settings)}\u0000${code}`;
  const cached = cellCache.get(key);
  if (cached) return cached;
  const computed = computeDeviceCells(code, settings);
  // 有界缓存：满了就整体丢弃，避免长时间运行的进程无限增长。
  if (cellCache.size >= CELL_CACHE_LIMIT) cellCache.clear();
  cellCache.set(key, computed);
  return computed;
}

function computeDeviceCells(
  code: string,
  settings: LayoutSettings,
): DeviceCells {
  const parsed = parseDeviceCode(code);
  if (!parsed) {
    // 非三段式：从名字里抽座位号，落到它所属的那一段上（其余段为 null）。
    const seat = seatNumberFromName(code);
    if (seat === null) return [null, null, null];
    for (const segment of [1, 2, 3] as const) {
      const cell = segmentCell(segment, seat, settings);
      if (cell)
        return [null, null, null].map((_, index) =>
          index === segment - 1 ? cell : null,
        ) as DeviceCells;
    }
    return [null, null, null];
  }
  return [
    segmentCell(1, parsed.a, settings),
    segmentCell(2, parsed.b, settings),
    segmentCell(3, parsed.c, settings),
  ];
}

/**
 * 把一台设备的“名字”解析成物理座位（docs §1.1）。
 *
 * - 三段式编号：按段判定区域，取第一个有归属的段（与 `deviceCells` 一致）；
 * - 单座位号（从名字里抽出）：按 `section1Start` / `section2Start` / `section3Start`
 *   判定区域，**顺序是 区域一 → 区域二 → 区域三**。默认设置下 `41` 同时满足
 *   区域二（`>= 31`）与区域三（`>= 41`），按此顺序落到区域二；教师若需要把
 *   区域三前移，把 `section2Start` 调大或 `section1End` 调大即可，判定顺序不变。
 */
export function resolveSeat(
  code: string,
  settings: LayoutSettings,
): DeviceSegment | null {
  return primarySegment(deviceCells(code, settings));
}

/**
 * 设备所属房间/区域（docs §1 的约定）：
 * 取**第 1 段**所在区域；第 1 段无归属时取第一个有归属的段；
 * 三段都没有归属（几何未知）返回 null。
 *
 * 该定义与 `primarySegment` 一致，也是 `allowCrossArea=false` 时
 * “同一房间”判定的依据。
 */
export function deviceArea(
  code: string,
  settings: LayoutSettings,
): 1 | 2 | 3 | null {
  return primarySegment(deviceCells(code, settings))?.area ?? null;
}

/** 设备主段落：第一段有归属的段（区域一/二/三之一）。 */
function primarySegment(cell: DeviceCells): DeviceSegment | null {
  for (const candidate of cell) if (candidate) return candidate;
  return null;
}

/**
 * 四人桌几何（docs §1.1 用户最终确认版）：区域一/三的一张桌子四个角各一台电脑，
 * 两两相对；桌与桌之间接着排下一张。
 *
 * ```
 *       桌面
 *  1 ──────── 3      1 与 3 面对面（长边两端）
 *  │          │      2 与 4 面对面
 *  2 ──────── 4      1 与 2 并排（同一短边），3 与 4 并排
 *
 *  3 ──────── 5      3 与 5 背对背（桌与桌之间）
 *  4 ──────── 6      4 与 6 背对背
 * ```
 *
 * `t = pos − 1`、`desk = ⌊t / 4⌋`、`corner = t % 4`：
 *
 * | `corner` | 桌上位置 | 本桌示例 | 相邻桌示例 |
 * | --- | --- | --- | --- |
 * | 0 | 长边一端·上 | 1 | 5 |
 * | 1 | 长边一端·下 | 2 | 6 |
 * | 2 | 长边另一端·上 | 3 | 7 |
 * | 3 | 长边另一端·下 | 4 | 8 |
 */
function quadOf(segment: DeviceSegment): { desk: number; corner: number } {
  const t = segment.pos - 1;
  const desk = Math.floor(t / 4);
  // corner = t mod 4：0 上左、1 下左、2 上右、3 下右（同屏短边并排成对）。
  const corner = t - desk * 4;
  return { desk, corner };
}

/**
 * 区域二几何：列（1 上排奇数 / 0 下排偶数）、从同一端起算的列号（0 基）。
 *
 * `31` 与 `32` 是从同一端数的**第一个**上下正对，因此两排共用同一个列号：
 * 上排 `31 33 35…`、下排 `32 34 36…` 对应列号 `0 1 2…`。
 * 写成 `⌊(v − 2) / 2⌋` 会让 31 得 14、32 得 15，把正对位置错开一位。
 */
function rowOf(
  segment: DeviceSegment,
  settings: LayoutSettings,
): { column: number; row: number } {
  // 两排从同一个起点编号：起点与起点+1 正对（同列），起点+2 回到上一排的下一列。
  // 因此列号 = ⌊(编号 − 起点) / 2⌋，与起点是否奇偶无关。
  const offset = segment.value - settings.section2Start;
  return {
    column: offset % 2 === 0 ? SECTION2_ODD : SECTION2_EVEN,
    row: Math.floor(offset / 2),
  };
}

const NOTHING: AdjacencyRelation = "none";
const EXCELLENT: AdjacencyRelation = "excellent";
const GOOD: AdjacencyRelation = "good";
const FAIR: AdjacencyRelation = "fair";
const DEGRADED: AdjacencyRelation = "degraded";

/** 桌内是否为“同一短边并排”（{0,1}、{2,3}）。 */
function sameShortEdge(a: number, b: number): boolean {
  return Math.floor(a / 2) === Math.floor(b / 2);
}

/**
 * 同一张四人桌上两个 corner 的关系（docs §1.2）。
 * 判定标准只有一条：**能不能直接看到对方屏幕**。
 * - `{0,1}`、`{2,3}` 同一短边并排 ⇒ `side-by-side` ⇒ excellent；
 * - `{0,2}`、`{1,3}` 长边两端面对面 ⇒ `face-to-face` ⇒ degraded；
 * - `{0,3}`、`{1,2}` 斜对角 ⇒ `diagonal` ⇒ degraded。
 * 面对面与斜对角都看不到对方屏幕，等级相同。
 */
function sameDeskRelation(a: number, b: number): AdjacencyRelation {
  if (a === b) return NOTHING;
  // side-by-side {0,1}、{2,3}：同一短边并排，一眼同屏 ⇒ excellent。
  if (sameShortEdge(a, b)) return EXCELLENT;
  // face-to-face {0,2}、{1,3} 与 diagonal {0,3}、{1,2}：都看不见对方屏幕。
  return DEGRADED;
}

/**
 * 同一区域内两个段落的相邻关系（docs §1.2 的固定优先序）。
 * **唯一判定标准：两个人坐着时能否直接看到对方的屏幕。**
 *
 * 区域一/三（四人桌）：
 * 1. `side-by-side`：同 `desk` 且同短边（`1 2`、`3 4`、`5 6`）⇒ excellent；
 * 2. `corner-facing`：相邻两桌，前桌远角 `{2,3}` 对后桌近角 `{0,1}`
 *    （`3 5`、`4 6`、`7 9`），角对角、回头可见 ⇒ good；
 * 3. `face-to-face`（`1 3`、`2 4`、`5 7`）与 `diagonal`（`1 4`、`2 3`）
 *    都看不见对方屏幕 ⇒ degraded；
 * 其余（隔桌、跨桌近对近/远对远）⇒ none。
 *
 * 区域二（两条长排）：
 * - 同排相邻（`31 33`）⇒ 肩并肩，excellent；
 * - 同排隔一个空位（`31 35`，中间那位被别人占了）仍能侧头看 ⇒ fair；
 * - 不同排（正对 `31 32`，或绕到对面 `31 34`）⇒ degraded；
 * - 更远 ⇒ none。
 */
function sameAreaRelation(
  left: DeviceSegment,
  right: DeviceSegment,
  settings: LayoutSettings,
): AdjacencyRelation {
  if (left.area === 2) {
    const a = rowOf(left, settings);
    const b = rowOf(right, settings);
    const gap = Math.abs(a.row - b.row);
    if (a.column === b.column) {
      /*
       * 同一条长排。注意长排的座位号是隔一个递增的（31、33、35…），
       * 因此 row 相差 1 就是**紧挨着**的两个人 —— 与四人桌的肩并肩同级，
       * 用户明确说“有长排能排列在一起的最好”。row 相差 2 表示中间隔了
       * 一个人的位置但那位空着（或被别人占了），仍能侧头看到 ⇒ fair。
       * 再远就不相邻。
       */
      if (gap === 1) return EXCELLENT;
      // 隔一空位（31 与 35，中间 33 空着）：仍能侧头看到 ⇒ fair。
      if (gap === 2) return FAIR;
      return NOTHING;
    }
    // 不同排：正对或被错开地绕到对面，都必须起身绕到整排对面 ⇒ 看不见屏幕。
    return DEGRADED;
  }
  const a = quadOf(left);
  const b = quadOf(right);
  if (a.desk === b.desk) return sameDeskRelation(a.corner, b.corner);
  if (Math.abs(a.desk - b.desk) !== 1) return NOTHING;
  // 桌与桌之间只有“前桌远端（corner 2/3）↔ 后桌近端（corner 0/1）”
  // 是角对角、回头就能看到对方屏幕 ⇒ corner-facing ⇒ good；
  // 近对近、远对远在几何上错开，不构成相邻。
  const far = a.desk < b.desk ? a.corner : b.corner;
  const near = a.desk < b.desk ? b.corner : a.corner;
  if (far >= 2 && near < 2) return GOOD;
  return NOTHING;
}

function worst(a: AdjacencyRelation, b: AdjacencyRelation): AdjacencyRelation {
  return RELATION_RANK[a] >= RELATION_RANK[b] ? a : b;
}

/**
 * 两个设备编号之间的相邻关系。
 *
 * 一台设备通常只在一个段落上有几何归属（其余段为 0 或越界值），
 * 因此先取两者的主段落（第一个有归属的段）：
 * - 两者主区域不同 ⇒ 跨区域：`allowCrossArea=false` 时 none，否则 good
 *   （方案评分还会把它封顶到 fair，见 §2 的同房间约束）；
 * - 同一主区域 ⇒ 按 §1.2 的桌面几何判定；
 * - 任一设备几何未知（没有主段落）⇒ none。
 * 若两者的主段落在不同段落上（例如第 1 段对第 3 段），同样视为跨区域处理。
 */
export function adjacencyGradeOf(
  a: string,
  b: string,
  settings: LayoutSettings,
): AdjacencyRelation {
  if (!isSettings(settings)) return NOTHING;
  const left = primarySegment(deviceCells(a, settings));
  const right = primarySegment(deviceCells(b, settings));
  if (!left || !right) return NOTHING;
  if (left.area !== right.area) return settings.allowCrossArea ? GOOD : NOTHING;
  return sameAreaRelation(left, right, settings);
}

/** 学生座位极差按区域分别累计后的总和。 */
export function spanOf(codes: string[], settings: LayoutSettings): number {
  if (!isSettings(settings) || !Array.isArray(codes) || codes.length === 0)
    return 0;
  const byArea = new Map<1 | 2 | 3, { min: number; max: number }>();
  for (const code of codes) {
    const segment = primarySegment(deviceCells(code, settings));
    if (!segment) continue;
    const current = byArea.get(segment.area);
    if (!current)
      byArea.set(segment.area, { min: segment.pos, max: segment.pos });
    else {
      if (segment.pos < current.min) current.min = segment.pos;
      if (segment.pos > current.max) current.max = segment.pos;
    }
  }
  let total = 0;
  for (const { min, max } of byArea.values()) total += max - min;
  return total;
}

export interface ArrangementScore {
  grade: AdjacencyGrade;
  span: number;
  crossArea: boolean;
  /** 能连成一条不间断座位线的最长人数（docs §1.3）。 */
  run: number;
}

function compareCodes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const AREA_ORDER: Array<1 | 2 | 3> = [1, 2, 3];

/** 座位在主段落上的全局序：先按区域，再按区域序号（仅用于相邻对排序）。 */
function seatOrder(code: string, settings: LayoutSettings): number {
  const segment = primarySegment(deviceCells(code, settings));
  if (!segment) return Number.MAX_SAFE_INTEGER;
  return AREA_ORDER.indexOf(segment.area) * 1_000_000 + segment.pos;
}

/**
 * 方案评分（docs §2）：
 * - grade 取方案内**全部两两配对**关系的最差者（文档的“相邻对”指方案内的
 *   关系集合；任意两人配不上就整组降级，这与“两两相邻”的语义一致）；
 * - 任一配对跨区域即 crossArea = true，并把等级封顶到 degraded
 *   （§2 同房间约束：不同房间的两个人没法一起讨论）；
 * - 最差关系为 none 时降级为 clustered，用 span 衡量集中度；
 * - 全部对都无法判定（几何未知）时记 scattered。
 */
/**
 * docs §1.3 的 `run`：方案内同一区域、同一排上座位号**连续**的最长人数。
 *
 * - 区域一/三（四人桌）：`desk * 2 + (corner < 2 ? 0 : 1)` 是“排号”，
 *   同一排上 `corner` 相差 2 的两人隔着一整张桌子，因此同排只按
 *   `2 * desk` 编号 + 该排两个位置（`corner` 0/2 或 1/3）判断连续性；
 *   为简单且稳定，这里把四人桌的一排定义为“同一 `corner % 2` 上的
 *   `desk` 序列”，座位号连续即可成线；
 * - 区域二（长排）：同一 `column` 上 `index` 连续。
 *
 * 只用方案内已选座位，不依赖候选全集，因此“被占用的座位跳过”会自然
 * 打断连续性——这正符合用户“中间有人用了可以跳过”只用于 `fair` 档的语义。
 */
export function runOf(codes: string[], settings: LayoutSettings): number {
  if (!isSettings(settings) || !Array.isArray(codes) || codes.length === 0)
    return 0;
  return runOfSegments(
    codes.map((code) => primarySegment(deviceCells(code, settings))),
    settings,
  );
}

/** `runOf` 的内部实现：直接吃已解析好的段落，供 `planSeats` 复用避免重复解析。 */
function runOfSegments(
  parsed: ReadonlyArray<DeviceSegment | null>,
  settings: LayoutSettings,
): number {
  if (parsed.length === 0) return 0;
  /** key -> 已选座位号集合；key 同时编码区域与“排号”。 */
  const lines = new Map<string, Set<number>>();
  for (const segment of parsed) {
    if (!segment) continue;
    let key: string;
    let seat: number;
    if (segment.area === 2) {
      const { column, row } = rowOf(segment, settings);
      key = `2:${column}`;
      seat = row;
    } else {
      const { desk, corner } = quadOf(segment);
      // 同一张桌的 `{0,1}` 与 `{2,3}` 各是一条短边的并排位，各自连成一条线，
      // 因此 key 用 corner 对（0/1 组或 2/3 组），seat 就是桌号：同一排上
      // 相邻两张桌的并排位连续，正好对应“一路排下去”。
      key = `${segment.area}:${corner < 2 ? 0 : 1}`;
      seat = desk;
    }
    const line = lines.get(key) ?? new Set<number>();
    line.add(seat);
    lines.set(key, line);
  }
  let longest = 0;
  for (const seats of lines.values()) {
    for (const seat of seats) {
      // 只在“这一段连续区间的起点”上计数，避免重复统计。
      if (seats.has(seat - 1)) continue;
      let length = 0;
      while (seats.has(seat + length)) length += 1;
      if (length > longest) longest = length;
    }
  }
  return longest;
}

export function scoreArrangement(
  chosen: string[],
  settings: LayoutSettings,
): ArrangementScore {
  const span = spanOf(chosen, settings);
  if (!isSettings(settings) || !Array.isArray(chosen) || chosen.length < 2)
    return {
      grade: chosen.length === 1 ? "excellent" : "clustered",
      span,
      crossArea: false,
      run: runOf(chosen, settings),
    };
  const ordered = [...chosen].sort((a, b) => {
    const gap = seatOrder(a, settings) - seatOrder(b, settings);
    return gap !== 0 ? gap : compareCodes(a, b);
  });
  const segments = ordered.map((code) =>
    primarySegment(deviceCells(code, settings)),
  );
  /*
   * 用户裁定（docs §1.3，2026-11-19 第五次修订）：同一条长排上连着坐成一段
   * （中间没有别人）时，整批算 `excellent`。长排的座位号是隔一个递增的
   * （31、33、35…），三人连坐时 `31 与 35` 中间隔着 `33`，按“两两配对取最差”
   * 会被这对拖成 `fair`，与“三个人就直接尽量排在长桌上”的现场判断相反。
   * 因此当全员都落在同一段连续长排上（`run === 人数` 且都在区域二）时直接给
   * `excellent`，不再逐对取最差。
   */
  const contiguousRow =
    ordered.length >= 2 &&
    segments.every((segment) => segment?.area === 2) &&
    runOf(ordered, settings) >= ordered.length;
  if (contiguousRow)
    return { grade: "excellent", span, crossArea: false, run: ordered.length };
  let crossArea = false;
  let decided = false;
  let worstRelation: AdjacencyRelation = EXCELLENT;
  // 全部两两配对取最差：docs §2 的“相邻对”是方案内的关系集合，
  // 任何一个配不上都会让整组降级。
  for (let left = 0; left < ordered.length; left += 1) {
    for (let right = left + 1; right < ordered.length; right += 1) {
      const a = segments[left];
      const b = segments[right];
      if (!a || !b) continue;
      decided = true;
      if (a.area !== b.area) {
        crossArea = true;
        worstRelation = worst(worstRelation, GOOD);
      } else {
        worstRelation = worst(worstRelation, sameAreaRelation(a, b, settings));
      }
    }
  }
  if (!decided)
    return {
      grade: chosen.length > 1 ? "scattered" : "clustered",
      span,
      crossArea,
      run: runOf(chosen, settings),
    };
  // 最差关系为 none ⇒ 整组并非“相邻”，交给 clustered 的 span 集中度衡量；
  // 其余三档（excellent/good/fair）与关系等级同名同序。
  let grade: AdjacencyGrade = gradeOfRank(RELATION_RANK[worstRelation]);
  // §2 同房间约束：任一配对跨区域即封顶到 fair。
  if (crossArea && GRADE_RANK[grade] < GRADE_RANK.degraded) grade = "degraded";
  return { grade, span, crossArea, run: runOf(ordered, settings) };
}

export interface SeatPlan {
  codes: string[];
  order: number[];
  grade: AdjacencyGrade;
  span: number;
  crossArea: boolean;
  /** 本方案内能连成一条不间断座位线的最长人数（docs §1.3 的 run）。 */
  run: number;
}

/**
 * 从候选设备里为 count 名学生挑座位：按 docs §2 取最优等级，
 * 同等级取最小 span，再取字典序最小（候选先按字典序排序）方案。
 *
 * 实现是带下界剪枝的组合 DFS（分支限界），不是全排列：
 * 1. 预计算 n×n 的关系矩阵，DFS 内 O(1) 查表；
 * 2. 增量维护“已选集合的最差关系等级”，一旦劣于当前最优即整枝剪掉；
 * 3. 同等级下 span 单调不减，超过最优 span 即剪枝；
 * 4. 找到等级 0（excellent）立即早退。
 * 最坏复杂度 C(n, k)，实测在 n≤160、k≤12 的规模内受剪枝约束可即时返回。
 */
export function planSeats(
  codes: string[],
  count: number,
  settings: LayoutSettings,
): SeatPlan | null {
  if (!isSettings(settings) || !Array.isArray(codes)) return null;
  if (!Number.isInteger(count) || count <= 0) return null;
  if (count > codes.length) return null;
  if (new Set(codes).size !== codes.length) return null;
  const input = [...codes];
  // 字典序排序保证遍历顺序稳定，与调用方传入顺序无关。
  const sorted = [...codes].sort(compareCodes);
  const n = sorted.length;
  const segments = sorted.map((code) =>
    primarySegment(deviceCells(code, settings)),
  );
  const rank = (i: number, j: number): number => {
    const a = segments[i];
    const b = segments[j];
    if (!a || !b) return NONE_RANK;
    if (a.area !== b.area)
      return settings.allowCrossArea ? RELATION_RANK.good : NONE_RANK;
    return RELATION_RANK[sameAreaRelation(a, b, settings)];
  };
  const pairRank: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(NONE_RANK),
  );
  for (let i = 0; i < n; i += 1)
    for (let j = i + 1; j < n; j += 1) {
      const value = rank(i, j);
      pairRank[i]![j] = value;
      pairRank[j]![i] = value;
    }
  const position = new Map<string, number>();
  input.forEach((code, index) => position.set(code, index));
  const chosen: number[] = [];
  let best: SeatPlan | null = null;
  let bestRank = NONE_RANK;
  let bestSpan = Number.POSITIVE_INFINITY;
  let bestRun = -1;
  let stopped = false;
  const record = (worstRank: number, span: number): void => {
    const picked = chosen.map((index) => sorted[index]!);
    const run = runOfSegments(
      chosen.map((index) => segments[index] ?? null),
      settings,
    );
    /*
     * 与 `scoreArrangement` 同一条裁定：全员落在同一段连续长排上时整批算
     * `excellent`（长排座位号隔位递增，31 与 35 之间的 33 其实是相邻的人）。
     * 这里把关系秩压到 0，让它与真正的“同桌并排”同档，从而在 3 人场景下
     * 优先于四人桌上“excellent + good”的零散方案。
     */
    const onOneRow =
      picked.length >= 2 &&
      chosen.every((index) => segments[index]?.area === 2) &&
      run >= picked.length;
    if (onOneRow) worstRank = 0;
    // 跨区域（mixed）不能靠“区域二两人连坐 + 区域一一人”取胜：
    // docs §2 的同房间约束要求跨区域封顶到 degraded，除非确实排不成一段。
    else {
      let areas = new Set<number>();
      for (const index of chosen) {
        const segment = segments[index];
        if (segment) areas.add(segment.area);
      }
      if (areas.size > 1 && !settings.allowCrossArea)
        worstRank = Math.max(worstRank, DEGRADED_RANK);
    }
    // docs §1.3：等级 → run（越大越优先）→ span（越小越优先）→ 字典序。
    // worstRank 是关系秩（越小越好），因此只有“更差”才丢失。
    if (worstRank > bestRank) return;
    // 同等级时：run 更大 → 直接替换；run 相同再比 span。
    const sameRank = worstRank === bestRank;
    if (sameRank) {
      if (run < bestRun) return;
      if (run === bestRun && span >= bestSpan) return;
    }
    bestRank = worstRank;
    bestSpan = Number.POSITIVE_INFINITY;
    let crosses = false;
    for (let i = 0; i < chosen.length && !crosses; i += 1)
      for (let j = i + 1; j < chosen.length; j += 1) {
        const a = segments[chosen[i]!];
        const b = segments[chosen[j]!];
        if (a && b && a.area !== b.area) {
          crosses = true;
          break;
        }
      }
    best = {
      codes: picked,
      order: picked.map((code) => position.get(code) ?? 0),
      grade: gradeOfRank(worstRank),
      span,
      crossArea: crosses,
      run,
    };
    bestSpan = span;
    bestRun = run;
    // 早退条件只在“已经连成一整条线”时成立：此时 run 已达人数上限，
    // 等级也已是 0，不可能再被同等级、更大 run 的方案取代。
    // 注意不能用 `bestRank === 0` 把整个搜索停掉——同等级下还要比较 run。
    if (worstRank === 0 && run >= count) stopped = true;
  };
  /**
   * 剪枝用的“还能不能凑成一条整排”判断：从 `index` 起（含）向后，是否还有
   * 足够多的候选能补满当前剩余名额，并且这些候选全部落在区域二同一条长排上。
   * 只有这种情况下才可能触发 `record` 的整排豁免，否则按秩剪枝是安全的。
   */
  const remainingAreasForRun = (index: number): boolean => {
    const need = count - chosen.length;
    /** 区域二每一条长排还剩多少可用座位。 */
    const perRow = new Map<number, number>();
    for (let rest = index; rest < n; rest += 1) {
      const cell = segments[rest];
      if (!cell || cell.area !== 2) continue;
      const { column } = rowOf(cell, settings);
      perRow.set(column, (perRow.get(column) ?? 0) + 1);
    }
    for (const available of perRow.values()) if (available >= need) return true;
    return false;
  };

  /**
   * @param start   候选切片起点（组合枚举，保证下标递增）
   * @param worstRank 已选集合内的最差关系等级（增量维护）
   * @param span    已选座位按区域累计的极差
   */
  // 搜索预算：组合数最坏可达 C(n,k)，用节点上限保证最差情况也是确定的
  // 有限时间返回（返回当前已找到的最优解，不抛异常）。
  let budget = 400_000;
  const visit = (start: number, worstRank: number, span: number): void => {
    // 只有 stopped（已找到 run 达标的等级 0 方案）才整体停止；
    // 不能因为 bestRank === 0 就返回，否则同等级下 run 更大的方案再也找不到。
    if (stopped) return;
    // 已找到“全员一段长排”的 excelente 方案时，run 不可能更大，可安全收尾。
    if (bestRun >= count && bestRank === 0) {
      stopped = true;
      return;
    }
    if (budget-- <= 0) {
      stopped = true;
      return;
    }
    if (chosen.length === count) {
      record(worstRank, span);
      return;
    }
    const remaining = count - chosen.length;
    if (n - start < remaining) return;
    for (let index = start; index <= n - remaining; index += 1) {
      const segment = segments[index];
      /*
       * 剪枝下界：partial 内两两关系的最差秩单调不减，所以它已经劣于当前最优时，
       * 继续加深不可能变好——**除非**最终全员落在同一段连续长排上（`record` 对
       * 这种方案直接判 excellent）。因此只有在“剩余候选已经凑不成一条整排”时，
       * 才能按秩安全剪枝。
       */
      let nextRank = worstRank;
      for (const picked of chosen) {
        const value = pairRank[index]![picked]!;
        if (value > nextRank) nextRank = value;
      }
      if (nextRank > bestRank && !remainingAreasForRun(index)) continue;
      let nextSpan = span;
      if (segment && chosen.length > 0) {
        // 增量极差：所选座位在各自区域内形成 [min,max] 区间并求和。
        let min = segment.pos;
        let max = segment.pos;
        let same = false;
        for (const picked of chosen) {
          const other = segments[picked];
          if (!other || other.area !== segment.area) continue;
          same = true;
          if (other.pos < min) min = other.pos;
          if (other.pos > max) max = other.pos;
        }
        if (same) {
          let previous = 0;
          let pMin = Number.POSITIVE_INFINITY;
          let pMax = Number.NEGATIVE_INFINITY;
          for (const picked of chosen) {
            const other = segments[picked];
            if (!other || other.area !== segment.area) continue;
            if (other.pos < pMin) pMin = other.pos;
            if (other.pos > pMax) pMax = other.pos;
          }
          if (Number.isFinite(pMin)) previous = pMax - pMin;
          const unionMin = Math.min(
            pMin === Number.POSITIVE_INFINITY ? min : pMin,
            min,
          );
          const unionMax = Math.max(
            pMax === Number.NEGATIVE_INFINITY ? max : pMax,
            max,
          );
          nextSpan = span - previous + (unionMax - unionMin);
        }
      }
      if (nextRank === bestRank && nextSpan > bestSpan) continue;
      chosen.push(index);
      visit(index + 1, nextRank, nextSpan);
      chosen.pop();
      if (stopped) return;
    }
  };
  // 贪心构造初始上界：按“与已选集合最差关系最优、其次 span 增量最小、
  // 最后字典序”逐个挑座位。它给出可剪枝的初始 bestRank，避免在最差情况下
  // 先枚举大量劣解；随后的 DFS 只需找到不劣于它的方案。
  /*
   * 贪心构造初始上界。**必须和 `record` 用同一个比较键**（等级 → run 大 →
   * span 小），否则它先用“等级最优但零散”的方案占住 `bestRun`，随后 DFS
   * 找到的“全员一条整排”方案会因为 `run` 比较被判为不更优而丢弃。
   * 实测：候选里混入一台其他区域设备时，5 人以上批次曾整体退化成 clustered。
   */
  const greedy: number[] = [];
  const greedyKey = (trial: number[]): [number, number, number] => {
    let worstRank = 0;
    for (let i = 0; i < trial.length; i += 1)
      for (let j = i + 1; j < trial.length; j += 1) {
        const value = pairRank[trial[i]!]![trial[j]!]!;
        if (value > worstRank) worstRank = value;
      }
    const codes = trial.map((item) => sorted[item]!);
    return [worstRank, -runOf(codes, settings), spanOf(codes, settings)];
  };
  const betterKey = (a: number[], b: number[]): boolean => {
    for (let i = 0; i < a.length; i += 1)
      if (a[i]! !== b[i]!) return a[i]! < b[i]!;
    return false;
  };
  /*
   * 贪心做两组初值并取更优者：
   * 1) 通用贪心：每步选“等级最好、run 最大、span 最小”的座位；
   * 2) 整排贪心：对区域二每一条长排各试一次——从该排里按座位号顺序填满，
   *    剩余名额再用通用贪心补齐。这样可以保证“全员坐成一整排”的方案
   *    一定被当作初始上界，不会被通用贪心用零散方案抢先。
   */
  const greedyRun = (seed: number[]): number[] => {
    const picked = [...seed];
    while (picked.length < count) {
      let pickIndex = -1;
      let pickKey: number[] | null = null;
      for (let index = 0; index < n; index += 1) {
        if (picked.includes(index)) continue;
        const key = greedyKey([...picked, index]);
        if (pickKey === null || betterKey(key, pickKey)) {
          pickIndex = index;
          pickKey = key;
        }
      }
      if (pickIndex < 0) break;
      picked.push(pickIndex);
    }
    return picked;
  };
  const betterGreedy = (a: number[], b: number[]): boolean => {
    if (a.length !== count) return false;
    if (b.length !== count) return true;
    return betterKey(greedyKey(a), greedyKey(b));
  };
  // 以每条长排为种子各构造一次，作为候选初值。
  const seeds = new Map<number, number[]>();
  for (let index = 0; index < n; index += 1) {
    const cell = segments[index];
    if (!cell || cell.area !== 2) continue;
    const { column } = rowOf(cell, settings);
    const list = seeds.get(column) ?? [];
    list.push(index);
    seeds.set(column, list);
  }
  for (const indexes of seeds.values()) {
    // 同一条长排内按座位号顺序取，保证“连续成一排”。
    indexes.sort((x, y) => (segments[x]?.pos ?? 0) - (segments[y]?.pos ?? 0));
    const run = greedyRun(indexes.slice(0, Math.min(indexes.length, count)));
    if (betterGreedy(run, greedy)) ((greedy.length = 0), greedy.push(...run));
  }
  const general = greedyRun([]);
  if (betterGreedy(general, greedy))
    ((greedy.length = 0), greedy.push(...general));
  if (greedy.length === count) {
    const initialWorst = greedy.reduce((acc, index) => {
      for (const other of greedy) {
        if (other === index) continue;
        const value = pairRank[index]![other]!;
        if (value > acc) acc = value;
      }
      return acc;
    }, 0);
    const initialSpan = spanOf(
      greedy.map((item) => sorted[item]!),
      settings,
    );
    chosen.push(...greedy);
    record(initialWorst, initialSpan);
    chosen.length = 0;
    stopped = false;
  }
  visit(0, 0, 0);
  return best;
}
