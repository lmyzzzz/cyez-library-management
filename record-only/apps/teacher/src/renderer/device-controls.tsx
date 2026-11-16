import { useState } from "react";
import { Button, Select, toast } from "@record/ui";
import type { DeviceDTO } from "@record/protocol";
import type { LocalStatus } from "../shared/bridge.js";
import { errorText } from "./common.js";

export function ScanModeControl({
  status,
  refresh,
  disabled = false,
}: {
  status: LocalStatus | null;
  refresh: () => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <label className="scan-mode-control">
      登记模式
      <Select
        aria-label="登记模式"
        value={status?.scanMode ?? "manual"}
        disabled={!status || busy || disabled}
        onChange={async (event) => {
          const mode = event.target.value as "manual" | "automatic";
          setBusy(true);
          try {
            await window.library.call("setScanMode", { mode });
            refresh();
          } catch (error) {
            toast.error(errorText(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <option value="manual">手动 · 教师确认</option>
        <option value="automatic">自动 · 一次刷卡</option>
      </Select>
    </label>
  );
}

export function DeviceToggle({
  device,
  disabled,
  refresh,
}: {
  device: DeviceDTO;
  disabled: boolean;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const label = device.isDisabled ? "恢复" : "停用";
  return (
    <Button
      size="small"
      variant="ghost"
      aria-label={`${label} ${device.code}`}
      disabled={disabled || busy || (!device.isDisabled && !!device.active)}
      title={
        device.active && !device.isDisabled
          ? "使用中的设备不可禁用"
          : `${label}新登记`
      }
      onClick={async () => {
        setBusy(true);
        try {
          await window.library.call("disableDevice", {
            deviceId: device.id,
            expectedVersion: device.version,
            isDisabled: !device.isDisabled,
          });
          toast.success(`设备已${label}`);
        } catch (error) {
          toast.error(errorText(error));
        } finally {
          setBusy(false);
          refresh();
        }
      }}
    >
      {busy ? "处理中…" : label}
    </Button>
  );
}
