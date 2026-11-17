import { useEffect, useState } from "react";
import { Switch, toast } from "@record/ui";
import type { LocalStatus, ScanMode } from "../shared/bridge.js";
import { errorText } from "./common.js";

/**
 * 手动/自动登记模式开关。自动模式在预览就绪后立即提交一次，不再等待倒计时；
 * 手动模式由同一张卡再次刷卡或教师点击右下角按钮确认。切换结果以 main 的
 * 持久化结果为准，失败时保留当前模式。
 */
export function ScanModeSwitch({
  status,
  refresh,
  disabled = false,
}: {
  status: LocalStatus | null;
  refresh: () => void;
  disabled?: boolean;
}) {
  const [mode, setMode] = useState<ScanMode>(status?.scanMode ?? "manual");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (status?.scanMode) setMode(status.scanMode);
  }, [status?.scanMode]);
  const automatic = mode === "automatic";
  return (
    <div
      className="scan-mode"
      title={
        automatic
          ? "自动模式：刷卡有效后直接登记或结束，无需教师确认"
          : "手动模式：同一张卡再次刷卡，或由教师点击右下角按钮确认"
      }
    >
      <Switch
        label="自动模式"
        aria-label="自动登记模式"
        checked={automatic}
        disabled={!status || busy || disabled}
        onChange={async (event) => {
          const next: ScanMode = event.target.checked ? "automatic" : "manual";
          setBusy(true);
          try {
            await window.library.call("setScanMode", { mode: next });
            setMode(next);
            refresh();
          } catch (error) {
            toast.error(errorText(error));
          } finally {
            setBusy(false);
          }
        }}
      />
      <span className="scan-mode-hint">
        {automatic ? "刷卡后直接登记或结束" : "刷卡后由教师确认"}
      </span>
    </div>
  );
}
