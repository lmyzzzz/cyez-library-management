import type { ReactNode } from "react";
import { Minus, MonitorUp } from "lucide-react";
import {
  Button,
  IconButton,
  SettingsContent,
  SettingsRow,
  SettingsSection,
  Switch,
} from "@record/ui";
import type { WindowState } from "../shared/windows.js";
import { LibraryIcon, SettingsIcon } from "./common.js";
export const closedWindows: WindowState = {
  scanOpen: false,
  statusOpen: false,
  scanFullscreen: false,
  scanAutoFocus: true,
  displayCount: 1,
  scanDisplay: 0,
};
const command = (name: "minimize" | "toggleFullscreen" | "openSettings") =>
  void window.library.call("auxCommand", { command: name }).catch(() => {});
export const auxCommand = command;
/**
 * 刷卡窗口与状态悬浮窗的自绘标题栏。两个窗口不提供关闭：原关闭按钮的位置
 * 是设置按钮，点击后把管理后台切到前台并打开“窗口管理”。
 */
export function AuxTitleBar({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <header className="aux-titlebar">
      <div className="aux-title">
        <LibraryIcon width={15} height={15} aria-hidden="true" />
        <b>{title}</b>
        {subtitle && <span>{subtitle}</span>}
      </div>
      <div className="aux-controls">
        {children}
        <IconButton
          size="small"
          variant="ghost"
          label="最小化"
          icon={Minus}
          onClick={() => command("minimize")}
        />
        <IconButton
          size="small"
          variant="ghost"
          label="窗口设置"
          icon={SettingsIcon}
          onClick={() => command("openSettings")}
        />
      </div>
    </header>
  );
}
/** 管理后台“设置 - 窗口管理”：启动和关闭两个辅助窗口。 */
export function WindowSettings({
  state,
  onChange,
  onError,
}: {
  state: WindowState;
  onChange: (state: WindowState) => void;
  onError: (error: unknown) => void;
}) {
  const apply = (
    action:
      | "setAuxWindow"
      | "setScanAutoFocus"
      | "setScanFullscreen"
      | "moveScanDisplay",
    input: object,
  ) =>
    void window.library
      .call<WindowState>(action, input as never)
      .then(onChange)
      .catch(onError);
  return (
    <SettingsContent>
      <SettingsSection
        title="窗口管理"
        description="刷卡窗口和状态悬浮窗自身不能关闭，只能在这里启动或关闭。每次启动软件都会重新打开这两个窗口。"
      >
        <SettingsRow
          label="刷卡窗口"
          description="学生刷卡登记和结束使用的专用窗口。关闭后读卡器收到的刷卡不会被处理。"
        >
          <Switch
            label=""
            aria-label="刷卡窗口"
            checked={state.scanOpen}
            onChange={(e) =>
              apply("setAuxWindow", { window: "scan", open: e.target.checked })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="刷卡时自动切到前台"
          description="收到刷卡时把刷卡窗口切换到前台。与刷卡窗口标题栏中的勾选框相同。"
        >
          <Switch
            label=""
            aria-label="刷卡时自动切到前台"
            checked={state.scanAutoFocus}
            onChange={(e) =>
              apply("setScanAutoFocus", { enabled: e.target.checked })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="刷卡窗口全屏"
          description="在刷卡窗口当前所在的显示器上全屏显示。与刷卡窗口标题栏中的全屏按钮相同。"
        >
          <Switch
            label=""
            aria-label="刷卡窗口全屏"
            checked={state.scanFullscreen}
            disabled={!state.scanOpen}
            onChange={(e) =>
              apply("setScanFullscreen", { enabled: e.target.checked })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="刷卡窗口所在显示器"
          description={
            !state.scanOpen
              ? "刷卡窗口未启动。"
              : state.displayCount < 2
                ? "当前只连接了一个显示器。"
                : `当前在第 ${state.scanDisplay} 个显示器，共 ${state.displayCount} 个（从左到右排列）。切换后保持全屏或窗口化状态。`
          }
        >
          <Button
            size="small"
            icon={MonitorUp}
            disabled={!state.scanOpen || state.displayCount < 2}
            onClick={() => apply("moveScanDisplay", {})}
          >
            切换到下一个显示器
          </Button>
        </SettingsRow>
        <SettingsRow
          label="状态悬浮窗"
          description="置顶显示电脑使用状态，可备注和手动结束，便于与机房管理软件对照。"
        >
          <Switch
            label=""
            aria-label="状态悬浮窗"
            checked={state.statusOpen}
            onChange={(e) =>
              apply("setAuxWindow", {
                window: "status",
                open: e.target.checked,
              })
            }
          />
        </SettingsRow>
      </SettingsSection>
    </SettingsContent>
  );
}
