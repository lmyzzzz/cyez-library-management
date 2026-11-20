/**
 * 相邻几何与座位规划在 `@record/protocol` 里实现（纯函数、无 Node API）。
 *
 * 算法只有一份，位于 `packages/protocol/src/adjacency.ts`。
 * 这里只做转发，保持服务端已有的 `import { planSeats } from "@record/domain"`
 * 调用点不变。之所以下沉到 protocol：`@record/domain` 含 `node:crypto`
 * （`payloadDigest`），教师端 renderer 一旦 import domain 就会被 electron-vite
 * externalize 成 `__vite-browser-external`，导致打包失败。
 */
export {
  ADJACENCY_GRADES,
  GRADE_LABELS,
  GRADE_RANK,
  isValidSection1End,
  isValidSection3Start,
  isValidSection1Start,
  isValidSection2Start,
  parseDeviceCode,
  seatNumberFromName,
  resolveSeat,
  deviceCells,
  deviceArea,
  adjacencyGradeOf,
  spanOf,
  scoreArrangement,
  planSeats,
  runOf,
} from "@record/protocol";
export type {
  AdjacencyGrade,
  AdjacencyRelation,
  LayoutSettings,
  ParsedDeviceCode,
  DeviceSegment,
  DeviceCells,
  ArrangementScore,
  SeatPlan,
} from "@record/protocol";
