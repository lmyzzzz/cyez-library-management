import { BrowserWindow, screen, type WebContents } from "electron";
import {
  restoreBounds,
  type AuxWindow,
  type SavedBounds,
  type WindowRole,
  type WindowState,
} from "../shared/windows.js";
import type { TeacherEvent } from "../shared/bridge.js";
interface Settings {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string): Promise<unknown>;
}
const limits = {
  main: { width: 1280, height: 840, minWidth: 760, minHeight: 600 },
  scan: { width: 1100, height: 760, minWidth: 800, minHeight: 600 },
  status: {
    width: 380,
    height: 720,
    minWidth: 320,
    minHeight: 420,
    maxWidth: 720,
  },
} as const;
const titles = {
  main: "图书馆使用登记 · 管理后台",
  scan: "图书馆使用登记 · 刷卡",
  status: "图书馆使用登记 · 使用状态",
} as const;
/**
 * 管理后台、刷卡窗口和状态悬浮窗。窗口位置全部使用 Electron 的跨显示器 DIP
 * 坐标：全屏发生在窗口当前所在的显示器上，保存的位置只在仍可见时恢复。
 */
export class AppWindows {
  private windows = new Map<WindowRole, BrowserWindow>();
  private saved = new Map<WindowRole, SavedBounds>();
  private timers = new Map<WindowRole, NodeJS.Timeout>();
  private autoFocus = true;
  constructor(
    private options: {
      preload: string;
      renderer: string;
      devTools: boolean;
      settings: Settings;
      /** 应用正在退出；此时才允许关闭辅助窗口。 */
      quitting: () => boolean;
      onScanClosed: () => void;
    },
  ) {}
  async init() {
    this.autoFocus =
      (await this.options.settings.get("scanAutoFocus")) !== "false";
    const areas = screen.getAllDisplays().map((display) => display.workArea);
    for (const role of ["main", "scan", "status"] as const) {
      try {
        const raw = await this.options.settings.get(`window.${role}`);
        const bounds = raw
          ? restoreBounds(JSON.parse(raw), areas, limits[role])
          : null;
        if (bounds) this.saved.set(role, bounds);
      } catch {
        // 损坏的窗口位置只回退到默认布局。
      }
    }
  }
  url(role: WindowRole) {
    return role === "main"
      ? this.options.renderer
      : `${this.options.renderer}?window=${role}`;
  }
  get(role: WindowRole) {
    const window = this.windows.get(role);
    return window && !window.isDestroyed() ? window : undefined;
  }
  roleOf(contents: WebContents): WindowRole | undefined {
    for (const [role, window] of this.windows)
      if (!window.isDestroyed() && window.webContents === contents) return role;
    return undefined;
  }
  state(): WindowState {
    const scan = this.get("scan");
    return {
      scanOpen: !!scan,
      statusOpen: !!this.get("status"),
      scanFullscreen: !!scan?.isFullScreen(),
      scanAutoFocus: this.autoFocus,
    };
  }
  send(role: WindowRole, event: TeacherEvent) {
    const window = this.get(role);
    if (window && !window.webContents.isDestroyed())
      window.webContents.send("library:event", event);
  }
  broadcast(event: TeacherEvent) {
    for (const role of this.windows.keys()) this.send(role, event);
  }
  private changed() {
    this.broadcast({ type: "windows", state: this.state() });
  }
  create(role: WindowRole) {
    const existing = this.get(role);
    if (existing) return existing;
    const size = limits[role];
    const saved = this.saved.get(role);
    const area = screen.getPrimaryDisplay().workArea;
    // 悬浮窗默认贴在主显示器右侧；其余窗口由系统居中。
    const fallback =
      role === "status"
        ? {
            x: area.x + area.width - size.width - 24,
            y: area.y + 48,
            height: Math.max(
              size.minHeight,
              Math.min(size.height, area.height - 96),
            ),
          }
        : {};
    const window = new BrowserWindow({
      width: size.width,
      height: size.height,
      ...fallback,
      ...(saved
        ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
        : {}),
      minWidth: size.minWidth,
      minHeight: size.minHeight,
      ...(role === "status"
        ? {
            maxWidth: limits.status.maxWidth,
            alwaysOnTop: true,
            maximizable: false,
            fullscreenable: false,
          }
        : {}),
      title: titles[role],
      show: false,
      frame: false,
      backgroundColor: "#fffaf3",
      webPreferences: {
        devTools: this.options.devTools,
        preload: this.options.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    this.windows.set(role, window);
    const url = this.url(role);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, target) => {
      if (target.split("#")[0] !== url) event.preventDefault();
    });
    window.on("close", (event) => {
      if (this.options.quitting()) return;
      // 辅助窗口不提供关闭；Alt+F4 等系统入口同样忽略，只能在管理后台关闭。
      if (role !== "main") event.preventDefault();
    });
    window.on("closed", () => {
      clearTimeout(this.timers.get(role));
      this.timers.delete(role);
      if (this.windows.get(role) === window) this.windows.delete(role);
      if (role === "scan") this.options.onScanClosed();
      if (role !== "main") this.changed();
    });
    const remember = () => {
      clearTimeout(this.timers.get(role));
      this.timers.set(
        role,
        setTimeout(() => void this.persist(role), 400),
      );
    };
    window.on("resize", remember);
    window.on("move", remember);
    if (role === "scan") {
      const fullscreen = () => {
        remember();
        this.changed();
      };
      window.on("enter-full-screen", fullscreen);
      window.on("leave-full-screen", fullscreen);
      // 渲染进程重新加载后门控状态丢失，在其重新上报前不接收刷卡。
      window.webContents.on("did-start-loading", () =>
        this.options.onScanClosed(),
      );
    }
    return window;
  }
  /** 打开辅助窗口；默认不抢占管理后台的焦点。 */
  async open(role: AuxWindow) {
    if (this.get(role)) return;
    const window = this.create(role);
    await window.loadURL(this.url(role));
    if (window.isDestroyed()) return;
    window.showInactive();
    if (role === "scan" && this.saved.get("scan")?.fullscreen)
      window.setFullScreen(true);
    this.changed();
  }
  async close(role: AuxWindow) {
    const window = this.get(role);
    if (!window) return;
    await this.persist(role);
    window.destroy();
  }
  private async persist(role: WindowRole) {
    const window = this.get(role);
    if (!window) return;
    const fullscreen = window.isFullScreen();
    // 全屏或最大化时保留还原后的位置，这样下次仍回到同一个显示器。
    const bounds: SavedBounds = { ...window.getNormalBounds(), fullscreen };
    this.saved.set(role, bounds);
    await this.options.settings
      .set(`window.${role}`, JSON.stringify(bounds))
      .catch(() => {});
  }
  /** 退出前写回全部窗口位置。 */
  async flush() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const role of [...this.windows.keys()]) await this.persist(role);
  }
  raise(role: WindowRole) {
    const window = this.get(role);
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.moveTop();
    window.focus();
  }
  /** 收到刷卡时按用户选择把刷卡窗口切到前台。 */
  cardReceived() {
    if (this.autoFocus) this.raise("scan");
  }
  minimize(role: WindowRole) {
    this.get(role)?.minimize();
  }
  toggleFullscreen() {
    const window = this.get("scan");
    window?.setFullScreen(!window.isFullScreen());
  }
  async setAutoFocus(enabled: boolean) {
    this.autoFocus = enabled;
    await this.options.settings.set("scanAutoFocus", String(enabled));
    this.changed();
  }
  openSettings() {
    this.raise("main");
    this.send("main", { type: "openWindowSettings" });
  }
}
