import { useState } from "react";
import { Ban, RotateCcw } from "lucide-react";
import { IconButton, toast } from "@record/ui";
import type { DeviceDTO } from "@record/protocol";
import { errorText } from "./common.js";

/** 设备快捷停用/恢复。使用中的设备不能停用，服务端仍以占用与版本号校验。 */
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
  const restore = device.isDisabled;
  const label = restore ? "恢复" : "停用";
  const locked = !restore && !!device.active;
  return (
    <IconButton
      size="small"
      variant="ghost"
      label={`${label} ${device.code}`}
      icon={restore ? RotateCcw : Ban}
      title={
        busy ? "处理中…" : locked ? "使用中的设备不可停用" : `${label}新登记`
      }
      disabled={disabled || busy || locked}
      aria-busy={busy}
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
    />
  );
}
