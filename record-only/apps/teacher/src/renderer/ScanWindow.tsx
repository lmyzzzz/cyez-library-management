import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CreditCard, Maximize, Minimize } from "lucide-react";
import { AppToaster, IconButton, toast } from "@record/ui";
import type { ScanPreview } from "@record/protocol";
import type { LocalStatus } from "../shared/bridge.js";
import type { WindowState } from "../shared/windows.js";
import { errorText, useClock } from "./common.js";
import { AuxTitleBar, auxCommand, closedWindows } from "./aux-window.js";
import { Registration, EndForm } from "./flows.js";
function Clock() {
  const now = new Date(useClock());
  return (
    <time className="scan-idle-clock">
      {now.toLocaleTimeString("zh-CN", { hour12: false })}
    </time>
  );
}
/**
 * 专用刷卡窗口。只有停留在“请刷卡”等待页时才接受新的刷卡；流程进行中、
 * 提交中或未连接时收到的刷卡只在本窗口弹出提示。
 */
export function ScanWindow() {
  const [status, setStatus] = useState<LocalStatus | null>(null),
    [windows, setWindows] = useState<WindowState>(closedWindows),
    [flow, setFlow] = useState<ScanPreview | null>(null),
    [confirmSignal, setConfirmSignal] = useState(0),
    [busy, setBusy] = useState(false);
  const activeFlowId = useRef<string | null>(null);
  const refreshStatus = useCallback(async () => {
    setStatus(await window.library.call<LocalStatus>("status", {}));
  }, []);
  useEffect(() => {
    void window.library
      .call<WindowState>("windowState", {})
      .then((state) => setWindows({ ...closedWindows, ...state }))
      .catch(() => {});
    const poll = () => void refreshStatus().catch(() => {});
    poll();
    const timer = setInterval(poll, 3000);
    const unsubscribe = window.library.subscribe((event) => {
      if (event.type === "scan") {
        setConfirmSignal(0);
        activeFlowId.current = event.preview.id;
        setFlow(event.preview);
      } else if (event.type === "confirm") {
        if (activeFlowId.current === event.previewId)
          setConfirmSignal((value) => value + 1);
      } else if (event.type === "notice") toast.error(errorText(event.code));
      else if (event.type === "windows") setWindows(event.state);
      else if (event.type === "changed") poll();
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    void window.library
      .call("gate", {
        page: flow ? "flow" : "devices",
        modal: false,
        submitting: busy,
      })
      .catch(() => {});
  }, [!!flow, busy]);
  useEffect(() => {
    // 登录失效后正在进行的流程不能再提交。
    if (status === null || status.authenticated) return;
    activeFlowId.current = null;
    setFlow(null);
  }, [status?.authenticated]);
  const closeFlow = () => {
    const id = flow?.id;
    activeFlowId.current = null;
    setFlow(null);
    if (id)
      void window.library
        .call("cancelPreview", { previewId: id })
        .catch(() => {});
  };
  const done = () => {
    const ended = flow?.mode === "end";
    activeFlowId.current = null;
    setFlow(null);
    toast.success(ended ? "已结束使用" : "登记成功");
  };
  const blocked = !status
    ? "正在启动…"
    : !status.identityConfigured
      ? "尚未完成首次配置"
      : !status.authenticated
        ? "尚未登录服务器"
        : !status.online
          ? "服务器连接中断"
          : null;
  return (
    <div className="aux-window scan-window">
      <AuxTitleBar
        title="刷卡登记"
        subtitle={blocked ?? (flow ? "正在办理" : "等待刷卡")}
      >
        <label className="aux-check">
          <input
            type="checkbox"
            checked={windows.scanAutoFocus}
            onChange={(e) =>
              void window.library
                .call<WindowState>("setScanAutoFocus", {
                  enabled: e.target.checked,
                })
                .then(setWindows)
                .catch(() => {})
            }
          />
          刷卡时自动切到前台
        </label>
        <IconButton
          size="small"
          variant="ghost"
          label={windows.scanFullscreen ? "退出全屏" : "全屏"}
          icon={windows.scanFullscreen ? Minimize : Maximize}
          onClick={() => auxCommand("toggleFullscreen")}
        />
      </AuxTitleBar>
      <div className="aux-body">
        {flow ? (
          flow.mode === "start" ? (
            <Registration
              key={flow.id}
              preview={flow}
              online={!!status?.online}
              onDone={done}
              onCancel={closeFlow}
              onBusy={setBusy}
              confirmSignal={confirmSignal}
            />
          ) : (
            <EndForm
              key={flow.id}
              preview={flow}
              automatic
              online={!!status?.online}
              onDone={done}
              onCancel={closeFlow}
              onBusy={setBusy}
              confirmSignal={confirmSignal}
            />
          )
        ) : (
          <main className={`scan-idle ${blocked ? "is-blocked" : ""}`}>
            <span className="scan-idle-icon" aria-hidden="true">
              <CreditCard size={72} strokeWidth={1.4} />
            </span>
            <h1>{blocked ? "暂时无法刷卡" : "请刷卡"}</h1>
            <p>
              {blocked
                ? `${blocked}，请联系值班教师。`
                : "将校园卡贴近读卡器：未登记时开始使用，已登记时结束使用。"}
            </p>
            <Clock />
            <footer>
              <span>学校图书馆 · 自助登记终端</span>
              <span>读卡器：{status?.reader || "未检测"}</span>
            </footer>
          </main>
        )}
      </div>
      {createPortal(<AppToaster />, document.body)}
    </div>
  );
}
