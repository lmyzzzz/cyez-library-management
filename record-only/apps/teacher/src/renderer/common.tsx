import { useEffect, useState, type ReactNode } from "react";
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  IconButton,
  Modal,
  ModalDescription,
  ModalPanel,
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
  PROVIDER_CONFIGURATION_INVALID:
    "校园数据源连接、TLS 或视图字段校验失败，原配置未变。",
  PROVIDER_CONFIGURATION_DISABLED: "服务器尚未启用 SQL Server 校园数据源模式。",
  PROVIDER_CONFIGURATION_SAVE_FAILED:
    "校园数据源连接校验已通过，但服务端未能确认配置保存。请联系维护人员检查本系统数据库权限和存储状态。",
  SERVICE_UNAVAILABLE: "服务端暂时无法完成请求，请联系维护人员检查服务状态。",
  RATE_LIMITED: "操作过于频繁，请稍后重新输入并提交。",
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
  SCAN_RETURN_TO_DEVICES: "已收到刷卡，请先完成或取消当前操作后再刷卡。",
  SCAN_WINDOW_CLOSED:
    "已收到刷卡，但刷卡窗口已关闭。请在“设置 - 窗口管理”中启动刷卡窗口。",
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
  AUTO_LOGIN_FAILED: "自动登录失败，请检查服务器连接或手动登录。",
  AUTO_LOGIN_REQUIRES_SAVED_PASSWORD: "请先勾选保存密码，再启用自动登录。",
  READER_PROCESS_UNAVAILABLE:
    "读卡进程无法启动，请检查串口、参数或可执行文件。",
  READER_EXECUTABLE_INVALID: "请输入读卡进程的绝对 .exe 路径。",
  READER_PORT_LIST_FAILED: "无法枚举串口，请检查读卡进程安装或手动填写端口。",
  READER_PCSC_LIST_FAILED:
    "无法枚举 PC/SC 读卡器，请检查 ACR1552U 连接、驱动和 Windows Smart Card 服务。",
  IDENTITY_CONFIG_REQUIRED: "请先完成首次配置。",
  IDENTITY_ALREADY_CONFIGURED: "本机身份参数已经配置。",
  CLIENT_CONFIG_EXISTS: "配置文件已存在，请重新启动客户端。",
  CLIENT_CONFIG_SAVE_FAILED: "无法保存本机配置，请检查用户数据目录。",
  READER_CHANGE_BUSY: "正在切换读卡进程，请稍候。",
  CONCURRENT_CONFLICT: "发生并发冲突，请刷新并重新确认。",
  INPUT_INVALID: "输入不符合要求，请检查字段。",
  TAG_VERSION_CONFLICT: "标签已变化，请刷新后重试。",
  NETWORK_TIMEOUT: "连接超时，请检查服务器状态。",
  NOT_FOUND: "请求的对象不存在或已被删除，请刷新后重试。",
  TAG_NOT_FOUND: "所选标签已不存在，请刷新后重新选择。",
  REQUEST_ID_REUSED: "该请求编号已用于其他操作，请刷新后重试。",
  PREVIEW_MODE_INVALID: "预览类型与当前操作不匹配，请重新刷卡或重新预览。",
  PREVIEW_FORBIDDEN: "当前账号无权使用该预览，请重新刷卡。",
  PREVIEW_CAPACITY: "预览数量已达上限，请稍后重试。",
  SCAN_ID_REUSED: "该刷卡请求已处理，请勿重复提交。",
  SCAN_CAPACITY: "待处理的刷卡请求过多，请稍后再试。",
  SCAN_FAILED: "刷卡处理失败，请重新刷卡；如仍失败请联系维护人员。",
  CARD_FORMAT_INVALID: "卡号格式不符合要求，请检查读卡器配置或重新刷卡。",
  HASH_VERSION_UNSUPPORTED: "身份版本不受服务器支持，请核对本机身份配置。",
  BODY_TOO_LARGE: "提交内容过大，请精简备注后重试。",
  SESSION_CAPACITY: "登录会话数已达上限，请稍后重试。",
  OPERATION_NOT_FOUND: "待恢复的操作不存在或已处理，请刷新查看。",
  LOG_SOURCE_INVALID: "日志来源无效，操作未完成，请联系维护人员。",
  INTEGRITY_ERROR: "数据完整性校验失败，操作已停止，请联系维护人员。",
  CONNECTION_REQUIRED: "尚未建立服务器连接，请先在设置中配置并登录。",
  NETWORK_ABORTED: "网络连接已中断，请检查网络后重试。",
  RESPONSE_INVALID: "服务器响应格式异常，请稍后重试。",
  RESPONSE_TOO_LARGE: "服务器响应数据过大，操作未完成，请稍后重试。",
  NETWORK_TARGET_INVALID: "服务器地址或连接参数无效，请检查连接配置。",
  REDIRECT_REFUSED: "服务器返回了不允许的重定向，请检查服务器地址与证书配置。",
  REQUEST_FAILED: "请求未能完成，请检查网络后重试。",
  LOCAL_OPERATION_FAILED: "本机操作失败，请重试；如仍失败请联系维护人员。",
  IPC_FORBIDDEN: "当前界面无权执行该操作。",
  IPC_ACTION_INVALID: "操作请求无效，请刷新后重试。",
  PERSISTENCE_BOUNDARY_VIOLATION:
    "本地数据校验失败，操作已停止，请联系维护人员。",
  INTEGRATION_DISABLED: "当前环境未启用集成测试入口。",
};
export function errorText(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  return messages[code] ?? "操作未完成，请重试；如仍失败，请联系维护人员。";
}
import {
  BookOpen as LibraryIcon,
  Check as CheckIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  FileText as NoteIcon,
  LogIn as LoginIcon,
  Pencil as EditIcon,
  Plus as PlusIcon,
  Power as PowerIcon,
  RefreshCw as RefreshIcon,
  RotateCcw as ResetIcon,
  Settings as SettingsIcon,
  Square as StopIcon,
  Tag as TagIcon,
  Trash2 as TrashIcon,
} from "lucide-react";
export {
  LibraryIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  NoteIcon,
  LoginIcon,
  EditIcon,
  PlusIcon,
  PowerIcon,
  RefreshIcon,
  ResetIcon,
  SettingsIcon,
  StopIcon,
  TagIcon,
  TrashIcon,
};

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
  width = "medium",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  width?: "small" | "medium" | "large";
}) {
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ModalPanel title={title} close={onClose} width={width}>
        <ModalDescription className="dialog-description">
          {description ?? "请核对内容后操作。"}
        </ModalDescription>
        {children}
      </ModalPanel>
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
      <IconButton
        size="small"
        variant="ghost"
        label="上一页"
        icon={ChevronLeftIcon}
        disabled={page === 1}
        onClick={() => setPage(page - 1)}
      />
      <span>
        {page} / {Math.max(1, Math.ceil(total / pageSize))}
      </span>
      <IconButton
        size="small"
        variant="ghost"
        label="下一页"
        icon={ChevronRightIcon}
        disabled={page * pageSize >= total}
        onClick={() => setPage(page + 1)}
      />
    </footer>
  );
}
type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";
export function StatusBadge({
  status,
}: {
  status: "active" | "free" | "disabled";
}) {
  const text =
    status === "active" ? "使用中" : status === "disabled" ? "禁用" : "空闲";
  const tone: BadgeTone =
    status === "active"
      ? "accent"
      : status === "disabled"
        ? "neutral"
        : "success";
  return (
    <Badge tone={tone} data-status={status}>
      {text}
    </Badge>
  );
}
export function ConnectionState({
  authenticated,
  online,
  lastUpdated,
}: {
  authenticated: boolean;
  online: boolean;
  lastUpdated: number | null;
}) {
  const tone: BadgeTone = !authenticated
    ? "neutral"
    : online
      ? "success"
      : "warning";
  return (
    <div className="connection-state">
      <Badge tone={tone}>
        <span className={`dot ${online ? "online" : ""}`} aria-hidden="true" />
        {!authenticated ? "未登录" : online ? "已连接服务器" : "连接中断"}
      </Badge>
      <small>数据更新 {timestamp(lastUpdated)}</small>
    </div>
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
export function LiveDuration({ startedAtMs }: { startedAtMs: number }) {
  const now = useClock();
  return <>{duration(startedAtMs, now)}</>;
}
