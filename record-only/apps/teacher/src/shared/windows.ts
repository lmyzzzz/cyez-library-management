/** 三个窗口的角色：管理后台、刷卡窗口、状态悬浮窗。 */
export type WindowRole = "main" | "scan" | "status";
export type AuxWindow = Exclude<WindowRole, "main">;
export interface WindowState {
  scanOpen: boolean;
  statusOpen: boolean;
  scanFullscreen: boolean;
  /** 收到刷卡时是否自动把刷卡窗口切换到前台。 */
  scanAutoFocus: boolean;
  /** 已连接的显示器数量。 */
  displayCount: number;
  /** 刷卡窗口所在显示器的序号（从 1 开始，按从左到右、从上到下排列）；窗口关闭时为 0。 */
  scanDisplay: number;
}
/** 刷卡窗口面向学生，只开放刷卡流程需要的动作。 */
const scanActions = new Set([
  "status",
  "gate",
  "devices",
  "start",
  "end",
  "endPreview",
  "cancelPreview",
  "uiError",
  "windowState",
  "auxCommand",
  "setScanAutoFocus",
]);
/** 状态悬浮窗只复制主窗口的查看、备注和手动结束。 */
const statusActions = new Set([
  "status",
  "devices",
  "editNotes",
  "end",
  "endPreview",
  "cancelPreview",
  "uiError",
  "windowState",
  "auxCommand",
]);
/** 主窗口是管理后台：不再上报刷卡门控，也不使用辅助窗口的标题栏命令。 */
const mainDenied = new Set(["gate", "auxCommand"]);
export function roleAllows(role: WindowRole, action: string) {
  if (role === "scan") return scanActions.has(action);
  if (role === "status") return statusActions.has(action);
  return !mainDenied.has(action);
}
export function windowRole(search: string): WindowRole {
  const value = new URLSearchParams(search).get("window");
  return value === "scan" || value === "status" ? value : "main";
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SavedBounds extends Rect {
  fullscreen?: boolean;
}
/**
 * 校验上次保存的窗口位置。显示器可能已被拔掉或改变排列，只有标题栏仍落在
 * 某个显示器工作区内（可被拖动）时才恢复，否则返回 null 使用默认位置。
 */
export function restoreBounds(
  saved: unknown,
  workAreas: readonly Rect[],
  limits: { minWidth: number; minHeight: number; maxWidth?: number },
): SavedBounds | null {
  if (!saved || typeof saved !== "object") return null;
  const value = saved as Record<string, unknown>;
  for (const key of ["x", "y", "width", "height"] as const)
    if (!Number.isInteger(value[key])) return null;
  const rect = value as unknown as SavedBounds;
  if (rect.width < limits.minWidth || rect.height < limits.minHeight)
    return null;
  const width = Math.min(rect.width, limits.maxWidth ?? rect.width);
  const reachable = workAreas.some((area) => {
    const overlap =
      Math.min(rect.x + width, area.x + area.width) - Math.max(rect.x, area.x);
    return (
      overlap >= 120 && rect.y >= area.y && rect.y <= area.y + area.height - 48
    );
  });
  if (!reachable) return null;
  return {
    x: rect.x,
    y: rect.y,
    width,
    height: rect.height,
    fullscreen: value.fullscreen === true,
  };
}
