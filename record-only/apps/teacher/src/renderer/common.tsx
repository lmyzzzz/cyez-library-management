import { useEffect, useState, type ReactNode, type SVGProps } from "react";
import {
  Button,
  Banner,
  Modal,
  ModalTitle,
  ModalDescription,
  EmptyState,
} from "@record/ui";
import type { TeacherBridge } from "../shared/bridge.js";
import type { WindowControlsBridge } from "@series/electron/shared";
declare global {
  interface Window {
    library: TeacherBridge;
    windowControls: WindowControlsBridge;
  }
}
const messages: Record<string, string> = {
  STUDENT_NOT_ALLOWED:
    "校园资料服务未确认该学生的登记资格。请联系学校数据负责人。",
  CARD_ID_MISMATCH: "卡号与学生标识不一致，请重新刷卡。",
  PROVIDER_UNAVAILABLE: "校园资料服务暂不可用。已有使用记录仍可手动结束。",
  PROFILE_MISMATCH: "校园资料不符合字段要求，请稍后重刷。",
  PROFILE_VERSION_CONFLICT: "学生资料已刷新，请重新刷卡。",
  DEVICE_UNAVAILABLE: "设备已被占用、禁用或删除，请刷新后重选。",
  DEVICE_IN_USE: "设备正在使用，请先显式结束记录。",
  DEVICE_VERSION_CONFLICT: "设备已被其他客户端修改，请刷新后重新编辑。",
  RECORD_VERSION_CONFLICT: "记录已变化，请重新预览后确认。",
  TIME_RANGE_CONFLICT: "本次刷卡时间早于设备释放时间，请重新刷卡。",
  PREVIEW_EXPIRED: "预览已过期，请重新刷卡或重新预览。",
  PREVIEW_ALREADY_USED: "此预览已提交，请刷新查看结果。",
  HISTORY_READ_ONLY: "已结束的历史记录不可修改。",
  SCAN_RETURN_TO_DEVICES: "接收到刷卡消息，请返回主页面以触发登记",
  OFFLINE_NO_WRITE: "连接已中断，禁止新业务写入。请恢复连接。",
  COMMAND_PENDING: "提交结果待确认。恢复连接后按原请求查询，请勿重复提交。",
  COMMAND_BUSY: "正在提交，请稍候。",
  TLS_OR_NETWORK_FAILED:
    "无法建立受信任连接，请核对 IP、叶证书指纹、有效期和 IP SAN。",
  PIN_INVALID: "请输入 64 位 SHA-256 叶证书指纹，可使用冒号分隔。",
  IP_INVALID: "请输入服务器 IP 地址。",
  AUTH_REQUIRED: "登录已失效，请重新登录。",
  LOGIN_FAILED: "账号或密码错误。",
  SECURE_STORAGE_UNAVAILABLE: "系统加密存储不可用，登录信息仅保留在内存。",
  LOCAL_STORAGE_FAILED:
    "本地存储写入失败，已停止发送新命令。请释放空间后恢复。",
  STORAGE_WRITE_RESTRICTED: "服务器存储受限，当前操作不可用。",
  SAVED_LOGIN_UNAVAILABLE: "没有可用的已保存登录信息。",
  SAVED_LOGIN_ORIGIN_MISMATCH: "已保存账号属于其他服务器，请手动登录。",
  CONCURRENT_CONFLICT: "发生并发冲突，请刷新并重新确认。",
  INPUT_INVALID: "输入不符合要求，请检查字段。",
  TAG_VERSION_CONFLICT: "标签已变化，请刷新后重试。",
  NETWORK_TIMEOUT: "连接超时，请检查服务器状态。",
};
export function errorText(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  return (
    messages[code] ??
    `操作失败（${/^[A-Z_]+$/.test(code) ? code : "REQUEST_FAILED"}），请重试或查看诊断。`
  );
}
export function LibraryIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      {...props}
    >
      <path d="M4 4h6v16H4zM14 4h6v16h-6zM6 8h2m8 0h2M6 16h2m8 0h2" />
    </svg>
  );
}
export function SettingsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      {...props}
    >
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="3" fill="var(--surface,#fff)" />
      <circle cx="16" cy="17" r="3" fill="var(--surface,#fff)" />
    </svg>
  );
}
export function timestamp(ms: number | null) {
  return ms === null
    ? "—"
    : new Date(ms).toLocaleString("zh-CN", { hour12: false });
}
export function duration(start: number, end: number | null) {
  const seconds = Math.max(0, Math.floor(((end ?? Date.now()) - start) / 1000));
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
export function Dialog({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <section className={`dialog ${wide ? "wide" : ""}`}>
        <header>
          <ModalTitle>{title}</ModalTitle>
          <Button aria-label="关闭对话框" variant="ghost" onClick={onClose}>
            ×
          </Button>
        </header>
        <ModalDescription>
          {description ?? "请核对内容后操作。"}
        </ModalDescription>
        {children}
      </section>
    </Modal>
  );
}
export function Failure({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  return error ? (
    <Banner
      tone="error"
      actions={retry ? <Button onClick={retry}>重试</Button> : undefined}
    >
      {errorText(error)}
    </Banner>
  ) : null;
}
export function Empty({ text = "没有符合条件的记录" }: { text?: string }) {
  return <EmptyState icon={LibraryIcon} title={text} />;
}
export function Pager({
  page,
  pageSize,
  total,
  setPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  setPage: (p: number) => void;
}) {
  return (
    <footer className="pager">
      <span>
        共 {total} 条 · 每页 {pageSize} 条
      </span>
      <Button disabled={page === 1} onClick={() => setPage(page - 1)}>
        上一页
      </Button>
      <span>
        {page} / {Math.max(1, Math.ceil(total / pageSize))}
      </span>
      <Button
        disabled={page * pageSize >= total}
        onClick={() => setPage(page + 1)}
      >
        下一页
      </Button>
    </footer>
  );
}
export function useClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}
