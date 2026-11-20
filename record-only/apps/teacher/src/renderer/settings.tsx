import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Card,
  CheckField,
  ConfirmModal,
  Field,
  IconButton,
  Input,
  Page,
  PageHeader,
  Select,
  SettingsContent,
  SettingsRow,
  SettingsSection,
  Switch,
  TableContainer,
  Textarea,
  Toolbar,
  toast,
} from "@record/ui";
import type {
  DeviceDTO,
  TagDTO,
  Page as PageData,
  RecordDTO,
  StudentDTO,
  LayoutSettings,
  LayoutDTO,
} from "@record/protocol";
import {
  createDeviceSchema,
  DEFAULT_LAYOUT_SETTINGS,
  adjacencyGradeOf,
  GRADE_LABELS,
  isValidSection1End,
  isValidSection1Start,
  isValidSection2Start,
  isValidSection3Start,
} from "@record/protocol";
import type { LocalStatus } from "../shared/bridge.js";
import type { IdentityConfig } from "@record/protocol/identity";
import type { ReaderProcessConfig } from "../shared/reader-config.js";
import {
  Dialog,
  EditIcon,
  Failure,
  FieldError,
  Empty,
  LoginIcon,
  Pager,
  PlusIcon,
  RefreshIcon,
  ResetIcon,
  TrashIcon,
  timestamp,
  duration,
  errorText,
} from "./common.js";
export function InitialClientSetup({ onDone }: { onDone: () => void }) {
  const [hashVersion, setHashVersion] = useState(""),
    [fixedSaltHex, setFixedSaltHex] = useState(""),
    [issuer, setIssuer] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const save = async () => {
    setBusy(true);
    setError(undefined);
    const input: IdentityConfig = {
      hashVersion,
      fixedSaltHex,
      issuer,
      uidByteLengths: [4],
    };
    try {
      await window.library.call("initializeClient", input);
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      input.fixedSaltHex = "";
      setFixedSaltHex("");
      setBusy(false);
    }
  };
  return (
    <Page>
      <div className="page-stack initial-setup-page">
        <PageHeader title="首次配置" />
        <Card className="initial-setup-card">
          <p className="muted">
            身份参数须与服务器一致。配置创建后不可在此界面读取或修改。
          </p>
          <div className="form-grid">
            <Field label="身份版本" htmlFor="setup-hash-version">
              <Input
                id="setup-hash-version"
                value={hashVersion}
                autoComplete="off"
                onChange={(e) => setHashVersion(e.target.value)}
              />
            </Field>
            <Field label="发卡方" htmlFor="setup-issuer">
              <Input
                id="setup-issuer"
                value={issuer}
                autoComplete="off"
                onChange={(e) => setIssuer(e.target.value)}
              />
            </Field>
          </div>
          <Field label="固定盐（十六进制）" htmlFor="setup-salt">
            <Input
              id="setup-salt"
              type="password"
              value={fixedSaltHex}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setFixedSaltHex(e.target.value)}
            />
          </Field>
          <Failure error={error} />
          <div className="form-actions">
            <Button
              variant="primary"
              disabled={busy || !hashVersion || !issuer || !fixedSaltHex}
              onClick={() => void save()}
            >
              保存并继续
            </Button>
          </div>
        </Card>
      </div>
    </Page>
  );
}
export function ConnectionForm({
  status,
  refresh,
}: {
  status: LocalStatus | null;
  refresh: () => void;
}) {
  const [ip, setIp] = useState(""),
    [port, setPort] = useState(443),
    [pin, setPin] = useState(""),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [remember, setRemember] = useState(false),
    [autoLogin, setAutoLogin] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [message, setMessage] = useState("");
  const run = async (action: "test" | "login" | "saved" | "clear") => {
    setBusy(true);
    setError(undefined);
    setMessage("");
    try {
      if (action === "clear") {
        await window.library.call("clearSaved", {});
        setMessage("已清除保存的登录信息");
      } else if (action === "saved") {
        await window.library.call("loginSaved", {});
        setMessage("已登录，待确认提交已恢复");
      } else {
        await window.library.call("configure", { ip, port, pin });
        if (action === "test") {
          await window.library.call("testConnection", {});
          setMessage("连接及证书校验通过");
        } else {
          const input = { username, password, remember, autoLogin };
          setUsername("");
          setPassword("");
          try {
            await window.library.call("login", input);
          } finally {
            input.password = "";
          }
          setMessage("登录成功");
        }
      }
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setPassword("");
      setUsername("");
    }
  };
  const logout = async () => {
    setBusy(true);
    setError(undefined);
    setMessage("");
    try {
      await window.library.call("logout", {});
      setMessage("已退出登录");
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsContent>
      <SettingsSection
        title="服务器连接"
        description="输入完整的新配置以覆盖本机连接。已保存的配置不会回填，也不安装系统自签名证书。"
      >
        <SettingsRow label="服务器 IP">
          <Input
            aria-label="服务器 IP"
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder="例如 192.168.1.10"
          />
        </SettingsRow>
        <SettingsRow label="HTTPS 端口">
          <Input
            aria-label="HTTPS 端口"
            className="settings-number"
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
          />
        </SettingsRow>
        <SettingsRow
          label="叶证书 SHA-256 指纹"
          description="64 位十六进制，支持冒号分隔；不是 SHA-1 指纹。"
        >
          <Textarea
            aria-label="叶证书 SHA-256 指纹"
            className="settings-textarea fingerprint"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="64 位十六进制，支持冒号分隔"
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        title="共享账号"
        description="所有教师共用一个业务账号。只有勾选保存密码时，登录凭证才使用本机系统加密存储。"
      >
        <SettingsRow label="账号">
          <Input
            aria-label="共享账号"
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </SettingsRow>
        <SettingsRow label="密码">
          <Input
            aria-label="密码"
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </SettingsRow>
        <SettingsRow label="保存密码" description="使用本机系统加密存储">
          <Switch
            label=""
            aria-label="保存密码"
            checked={remember}
            onChange={(e) => {
              setRemember(e.target.checked);
              if (!e.target.checked) setAutoLogin(false);
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="启动时自动登录"
          description="需要先保存密码；已保存账号属于其他服务器时不会自动登录。"
        >
          <Switch
            label=""
            aria-label="启动时自动登录"
            checked={remember && autoLogin}
            disabled={!remember || busy}
            onChange={(e) => setAutoLogin(e.target.checked)}
          />
        </SettingsRow>
      </SettingsSection>
      <Failure error={error} />
      {message && <Banner tone="success">{message}</Banner>}
      <div className="form-actions">
        <Button size="small" disabled={busy} onClick={() => void run("test")}>
          检查连接
        </Button>
        <Button
          size="small"
          variant="primary"
          disabled={busy || !username || !password}
          onClick={() => void run("login")}
        >
          覆盖连接并登录
        </Button>
        <Button
          size="small"
          disabled={busy || !status?.authenticated}
          onClick={() => void logout()}
        >
          退出登录
        </Button>
        <IconButton
          size="small"
          variant="ghost"
          label="使用已保存登录"
          icon={LoginIcon}
          disabled={busy || !status?.savedCredentials}
          onClick={() => void run("saved")}
        />
        <IconButton
          size="small"
          variant="ghost"
          label="清除保存项"
          icon={TrashIcon}
          disabled={busy}
          onClick={() => void run("clear")}
        />
      </div>
    </SettingsContent>
  );
}
export function ProviderSettingsForm({
  authenticated,
}: {
  authenticated: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [saved, setSaved] = useState(false),
    [tlsValidation, setTlsValidation] = useState<
      "verify" | "trustServerCertificate"
    >("verify");
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !authenticated) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = (key: string) => String(data.get(key) ?? "").trim();
    const input = {
      host: value("host"),
      port: Number(value("port")),
      username: value("username"),
      password: String(data.get("password") ?? ""),
      caPem: value("caPem"),
      tlsValidation: value("tlsValidation") as
        | "verify"
        | "trustServerCertificate",
      uidEncoding: value("uidEncoding") as "hex8" | "decimal",
    };
    setBusy(true);
    setError(undefined);
    setSaved(false);
    const clear = () => {
      form.reset();
      setTlsValidation("verify");
      for (const field of Array.from(form.elements))
        if (
          field instanceof HTMLInputElement ||
          field instanceof HTMLTextAreaElement
        )
          field.value = "";
      for (const key of Array.from(data.keys())) data.delete(key);
      Object.assign(input, {
        host: "",
        port: 0,
        username: "",
        password: "",
        caPem: "",
        tlsValidation: "verify",
        uidEncoding: "hex8",
      });
    };
    try {
      const pending = window.library.call("replaceProviderConfig", {
        ...input,
      });
      clear();
      await pending;
      setSaved(true);
    } catch (e) {
      setError(e);
    } finally {
      clear();
      setBusy(false);
    }
  };
  return (
    <SettingsContent>
      {!authenticated && <Banner tone="warning">请先登录服务器。</Banner>}
      <form onSubmit={(event) => void submit(event)} autoComplete="off">
        <fieldset
          className="settings-fieldset"
          disabled={busy || !authenticated}
        >
          <SettingsSection
            title="SQL Server 数据源"
            description="从 Concard.dbo.v_ViewCardInfo 按卡号查询，只读取卡号、姓名、班级。连接使用 SQL Server 账号和 TLS。"
          >
            <SettingsRow label="SQL Server 地址">
              <Input
                aria-label="SQL Server 地址"
                name="host"
                required
                autoComplete="off"
              />
            </SettingsRow>
            <SettingsRow label="端口">
              <Input
                aria-label="端口"
                className="settings-number"
                name="port"
                type="number"
                min={1}
                max={65535}
                placeholder="1433"
                required
              />
            </SettingsRow>
            <SettingsRow label="数据库账号">
              <Input
                aria-label="数据库账号"
                name="username"
                required
                autoComplete="off"
              />
            </SettingsRow>
            <SettingsRow label="数据库密码">
              <Input
                aria-label="数据库密码"
                name="password"
                type="password"
                required
                autoComplete="new-password"
              />
            </SettingsRow>
            <SettingsRow label="数据源证书校验">
              <Select
                aria-label="数据源证书校验"
                name="tlsValidation"
                value={tlsValidation}
                onChange={(event) => {
                  const next = event.target.value as typeof tlsValidation;
                  if (next === "trustServerCertificate") {
                    const ca =
                      event.currentTarget.form?.elements.namedItem("caPem");
                    if (ca instanceof HTMLTextAreaElement) ca.value = "";
                  }
                  setTlsValidation(next);
                }}
              >
                <option value="verify">验证证书（默认）</option>
                <option value="trustServerCertificate">
                  跳过证书校验（仍使用 TLS 加密）
                </option>
              </Select>
            </SettingsRow>
            {tlsValidation === "verify" && (
              <SettingsRow label="TLS CA 证书（PEM，可留空）">
                <Textarea
                  aria-label="TLS CA 证书（PEM，可留空）"
                  className="settings-textarea fingerprint"
                  name="caPem"
                  spellCheck={false}
                />
              </SettingsRow>
            )}
            <SettingsRow label="卡号表示">
              <Select
                aria-label="卡号表示"
                name="uidEncoding"
                required
                defaultValue=""
              >
                <option value="" disabled>
                  请选择与校园卡库一致的表示
                </option>
                <option value="hex8">8 位十六进制</option>
                <option value="decimal">无符号十进制</option>
              </Select>
            </SettingsRow>
          </SettingsSection>
          {tlsValidation === "trustServerCertificate" && (
            <Banner tone="warning">
              此模式不验证 SQL Server
              的身份，仅加密传输。请确认数据库地址来自可信网络。
            </Banner>
          )}
          <p className="muted">
            完整填写新配置以覆盖服务端配置；提交后立即清空，本机不保存或回填。失败后须重新输入；若响应丢失，结果可能尚未确认。
          </p>
          <Failure error={error} />
          {saved && (
            <Banner tone="success">服务端已覆盖校园数据源配置。</Banner>
          )}
          <div className="form-actions">
            <Button
              size="small"
              variant="primary"
              type="submit"
              disabled={busy || !authenticated}
            >
              覆盖服务端配置
            </Button>
          </div>
        </fieldset>
      </form>
    </SettingsContent>
  );
}
export function ReaderSettings({
  status,
  refresh,
}: {
  status: LocalStatus;
  refresh: () => void;
}) {
  const [kind, setKind] = useState<ReaderProcessConfig["kind"]>("serial"),
    [port, setPort] = useState(""),
    [baudRate, setBaudRate] = useState(9600),
    [dataBits, setDataBits] = useState<5 | 6 | 7 | 8>(8),
    [parity, setParity] = useState<"none" | "odd" | "even">("none"),
    [stopBits, setStopBits] = useState<1 | 2>(1),
    [flowControl, setFlowControl] = useState<"none" | "hardware" | "software">(
      "none",
    ),
    [format, setFormat] = useState<
      "hex8" | "hex" | "decimal" | "octal" | "binary"
    >("hex8"),
    [acrReader, setAcrReader] = useState(""),
    [acrPollMs, setAcrPollMs] = useState(250),
    [acrByteOrder, setAcrByteOrder] = useState<"forward" | "reverse">(
      "forward",
    ),
    [acrProtocol, setAcrProtocol] = useState<"auto" | "t0" | "t1">("auto"),
    [acrAccessMode, setAcrAccessMode] = useState<"shared" | "exclusive">(
      "shared",
    ),
    [acrReaders, setAcrReaders] = useState<string[]>([]),
    [executable, setExecutable] = useState(""),
    [ports, setPorts] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [message, setMessage] = useState("");
  const scanPorts = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.library.call<{ ports: string[] }>(
        "listSerialPorts",
        {},
      );
      setPorts(result.ports);
      if (!result.ports.length) setMessage("未发现串口，可手动输入端口名称");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const scanAcrReaders = async () => {
    setBusy(true);
    setError(undefined);
    setMessage("");
    try {
      const result = await window.library.call<{ readers: string[] }>(
        "listAcr1552Readers",
        {},
      );
      setAcrReaders(result.readers);
      if (!result.readers.length) setMessage("未发现 ACR1552U PC/SC 读卡器");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setError(undefined);
    setMessage("");
    try {
      const choice: ReaderProcessConfig =
        kind === "serial"
          ? {
              kind,
              port,
              baudRate,
              dataBits,
              parity,
              stopBits,
              flowControl,
              format,
            }
          : kind === "acr1552"
            ? {
                kind,
                reader: acrReader,
                pollMs: acrPollMs,
                uidByteOrder: acrByteOrder,
                protocol: acrProtocol,
                accessMode: acrAccessMode,
              }
            : kind === "external"
              ? { kind, executable }
              : { kind };
      await window.library.call("configureReader", choice);
      setMessage("读卡进程已启动，新配置已覆盖");
      setPort("");
      setAcrReader("");
      setAcrByteOrder("forward");
      setAcrProtocol("auto");
      setAcrAccessMode("shared");
      setExecutable("");
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsContent>
      <SettingsSection
        title="读卡进程"
        description={`当前状态：${status.reader}。输入完整参数以覆盖本机读卡配置。`}
      >
        <SettingsRow label="读卡进程">
          <Select
            aria-label="读卡进程"
            value={kind}
            onChange={(e) =>
              setKind(e.target.value as ReaderProcessConfig["kind"])
            }
          >
            <option value="serial">内置串口进程</option>
            <option value="acr1552">ACR1552U-M1 (PC/SC)</option>
            <option value="external">外部读卡进程</option>
            <option value="mock">手动输入</option>
          </Select>
        </SettingsRow>
      </SettingsSection>
      {kind === "serial" && (
        <SettingsSection title="串口参数">
          <SettingsRow label="串口">
            <Input
              aria-label="串口"
              list="serial-port-options"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="例如 COM3"
            />
            <datalist id="serial-port-options">
              {ports.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </SettingsRow>
          <SettingsRow label="比特率">
            <Input
              aria-label="比特率"
              className="settings-number"
              type="number"
              min={300}
              max={921600}
              value={baudRate}
              onChange={(e) => setBaudRate(Number(e.target.value))}
            />
          </SettingsRow>
          <SettingsRow label="数据位">
            <Select
              aria-label="数据位"
              value={dataBits}
              onChange={(e) =>
                setDataBits(Number(e.target.value) as 5 | 6 | 7 | 8)
              }
            >
              {[5, 6, 7, 8].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          </SettingsRow>
          <SettingsRow label="校验位">
            <Select
              aria-label="校验位"
              value={parity}
              onChange={(e) => setParity(e.target.value as typeof parity)}
            >
              <option value="none">无</option>
              <option value="odd">奇校验</option>
              <option value="even">偶校验</option>
            </Select>
          </SettingsRow>
          <SettingsRow label="停止位">
            <Select
              aria-label="停止位"
              value={stopBits}
              onChange={(e) => setStopBits(Number(e.target.value) as 1 | 2)}
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
            </Select>
          </SettingsRow>
          <SettingsRow label="流控">
            <Select
              aria-label="流控"
              value={flowControl}
              onChange={(e) =>
                setFlowControl(e.target.value as typeof flowControl)
              }
            >
              <option value="none">无</option>
              <option value="hardware">硬件</option>
              <option value="software">软件</option>
            </Select>
          </SettingsRow>
          <SettingsRow label="卡号格式">
            <Select
              aria-label="卡号格式"
              value={format}
              onChange={(e) => setFormat(e.target.value as typeof format)}
            >
              <option value="hex8">十六进制（固定 8 位）</option>
              <option value="hex">十六进制（1–8 位）</option>
              <option value="decimal">十进制（1–10 位）</option>
              <option value="octal">八进制（1–11 位）</option>
              <option value="binary">二进制（1–32 位）</option>
            </Select>
          </SettingsRow>
        </SettingsSection>
      )}
      {kind === "acr1552" && (
        <SettingsSection title="ACR1552U-M1 PC/SC">
          <Banner tone="info">
            读卡器返回四字节
            UID。校园数据库存十进制卡号时，请在“校园数据源”的新配置中将“卡号表示”选择为“无符号十进制”并完整覆盖配置。
            此处的字节顺序决定 UID
            数值；仅在实卡对照确认后更改，所有教师端应保持一致，更改后同一卡片的学生
            ID 也会改变。
          </Banner>
          <SettingsRow label="PC/SC 读卡器">
            <Select
              aria-label="PC/SC 读卡器"
              value={acrReader}
              onChange={(e) => setAcrReader(e.target.value)}
            >
              <option value="">选择已连接的读卡器</option>
              {acrReaders.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </SettingsRow>
          <SettingsRow label="状态检查间隔（毫秒）">
            <Input
              aria-label="状态检查间隔（毫秒）"
              className="settings-number"
              type="number"
              min={100}
              max={2000}
              step={1}
              value={acrPollMs}
              onChange={(e) => setAcrPollMs(Number(e.target.value))}
            />
          </SettingsRow>
          <SettingsRow
            label="UID 字节顺序"
            description={`转换示例（非实际卡号）：响应 01 02 03 04，UID ${acrByteOrder === "forward" ? "01020304" : "04030201"}，十进制 ${acrByteOrder === "forward" ? "16909060" : "67305985"}。不截断 7/10 字节 UID，不拆分卡号，也不自动尝试其他格式。`}
          >
            <Select
              aria-label="UID 字节顺序"
              value={acrByteOrder}
              onChange={(e) =>
                setAcrByteOrder(e.target.value as "forward" | "reverse")
              }
            >
              <option value="forward">保持响应顺序（高位字节在前）</option>
              <option value="reverse">反转四字节（低位字节在前）</option>
            </Select>
          </SettingsRow>
          <SettingsRow
            label="PC/SC 通信协议"
            description="用于驱动兼容，不改变卡号进制。通常保持自动协商。"
          >
            <Select
              aria-label="PC/SC 通信协议"
              value={acrProtocol}
              onChange={(e) =>
                setAcrProtocol(e.target.value as "auto" | "t0" | "t1")
              }
            >
              <option value="auto">自动协商（默认）</option>
              <option value="t0">T=0</option>
              <option value="t1">T=1</option>
            </Select>
          </SettingsRow>
          <SettingsRow
            label="PC/SC 访问模式"
            description="通常使用共享；独占模式需要其他读卡软件释放设备。"
          >
            <Select
              aria-label="PC/SC 访问模式"
              value={acrAccessMode}
              onChange={(e) =>
                setAcrAccessMode(e.target.value as "shared" | "exclusive")
              }
            >
              <option value="shared">共享（默认）</option>
              <option value="exclusive">独占</option>
            </Select>
          </SettingsRow>
        </SettingsSection>
      )}
      {kind === "external" && (
        <SettingsSection title="外部读卡进程">
          <SettingsRow label="进程绝对路径">
            <Input
              aria-label="进程绝对路径"
              className="settings-path"
              value={executable}
              onChange={(e) => setExecutable(e.target.value)}
              placeholder="C:/Program Files/.../reader.exe"
            />
          </SettingsRow>
        </SettingsSection>
      )}
      <Failure error={error} />
      {message && <Banner tone="success">{message}</Banner>}
      <div className="form-actions">
        {kind === "serial" && (
          <IconButton
            size="small"
            variant="ghost"
            label="刷新串口列表"
            icon={RefreshIcon}
            disabled={busy}
            onClick={() => void scanPorts()}
          />
        )}
        {kind === "acr1552" && (
          <IconButton
            size="small"
            variant="ghost"
            label="刷新 PC/SC 读卡器"
            icon={RefreshIcon}
            disabled={busy}
            onClick={() => void scanAcrReaders()}
          />
        )}
        <Button
          size="small"
          variant="primary"
          disabled={
            busy ||
            (kind === "serial" && !port.trim()) ||
            (kind === "acr1552" && !acrReader) ||
            (kind === "external" && !executable.trim())
          }
          onClick={() => void save()}
        >
          覆盖并启动
        </Button>
      </div>
    </SettingsContent>
  );
}
export function DeviceEditor({
  device,
  tags,
  onDone,
  onCancel,
  onBusy,
}: {
  device: DeviceDTO | null;
  tags: TagDTO[];
  onDone: () => void;
  onCancel: () => void;
  onBusy: (v: boolean) => void;
}) {
  const [code, setCode] = useState(device?.code ?? ""),
    [name, setName] = useState(device?.displayName ?? ""),
    [notes, setNotes] = useState(device?.notes ?? ""),
    [disabled, setDisabled] = useState(device?.isDisabled ?? false),
    [tagIds, setTagIds] = useState(device?.tags.map((t) => t.id) ?? []),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const save = async () => {
    setBusy(true);
    onBusy(true);
    try {
      const body = {
        code,
        displayName: name,
        notes,
        isDisabled: disabled,
        tagIds,
      };
      if (device)
        await window.library.call("editDevice", {
          ...body,
          deviceId: device.id,
          expectedVersion: device.version,
        });
      else await window.library.call("createDevice", body);
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  return (
    <div className="dialog-settings">
      <SettingsContent>
        <SettingsSection title="设备信息">
          <SettingsRow label="设备编号">
            <Input
              aria-label="设备编号"
              value={code}
              maxLength={60}
              onChange={(e) => setCode(e.target.value)}
            />
          </SettingsRow>
          <SettingsRow label="设备名称">
            <Input
              aria-label="设备名称"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
          </SettingsRow>
          <SettingsRow label="设备备注">
            <Textarea
              aria-label="设备备注"
              className="settings-textarea"
              value={notes}
              maxLength={8000}
              onChange={(e) => setNotes(e.target.value)}
            />
          </SettingsRow>
          <SettingsRow
            label="禁用新登记"
            description="使用中的设备必须先结束记录，才能禁用或删除。"
          >
            <Switch
              label=""
              aria-label="禁用新登记（不会结束现有使用）"
              checked={disabled}
              disabled={!!device?.active && !device.isDisabled}
              onChange={(e) => setDisabled(e.target.checked)}
            />
          </SettingsRow>
        </SettingsSection>
        <SettingsSection
          title="筛选标签"
          description="标签仅用于筛选，不授予权限。"
        >
          <div className="tag-checks">
            {tags.map((t) => (
              <CheckField
                key={t.id}
                label={t.name}
                checked={tagIds.includes(t.id)}
                onChange={(e) =>
                  setTagIds(
                    e.target.checked
                      ? [...tagIds, t.id]
                      : tagIds.filter((id) => id !== t.id),
                  )
                }
              />
            ))}
          </div>
        </SettingsSection>
      </SettingsContent>
      <Failure error={error} />
      <div className="form-actions">
        <Button size="small" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button
          size="small"
          variant="primary"
          disabled={busy || !code.trim() || !name.trim()}
          onClick={() => void save()}
        >
          {busy ? "保存中…" : "保存设备"}
        </Button>
      </div>
    </div>
  );
}
export function TagManager({
  tags,
  refresh,
  onBusy,
}: {
  tags: TagDTO[];
  refresh: () => void;
  onBusy: (v: boolean) => void;
}) {
  const [name, setName] = useState(""),
    [editing, setEditing] = useState<TagDTO | null>(null),
    [deleting, setDeleting] = useState<TagDTO | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const mutate = async (remove = false) => {
    setBusy(true);
    setError(undefined);
    onBusy(true);
    try {
      if (remove && deleting)
        await window.library.call("deleteTag", {
          tagId: deleting.id,
          expectedVersion: deleting.version,
        });
      else if (editing)
        await window.library.call("editTag", {
          tagId: editing.id,
          expectedVersion: editing.version,
          name,
        });
      else await window.library.call("createTag", { name });
      setName("");
      setEditing(null);
      setDeleting(null);
      refresh();
      toast.success(
        remove ? "标签已删除" : editing ? "标签已保存" : "标签已新增",
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  return (
    <>
      <Toolbar className="tag-toolbar">
        <Input
          aria-label="标签名称"
          placeholder="标签名称"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          size="small"
          disabled={busy || !name.trim()}
          onClick={() => void mutate()}
        >
          {editing ? "保存标签" : "新增标签"}
        </Button>
        {editing && (
          <Button
            size="small"
            onClick={() => {
              setEditing(null);
              setName("");
            }}
          >
            取消编辑
          </Button>
        )}
      </Toolbar>
      <Failure error={error} />
      <div className="tag-list">
        {tags.map((t) => (
          <div className="tag-row" key={t.id}>
            <strong>{t.name}</strong>
            <div className="row-actions">
              <IconButton
                size="small"
                variant="ghost"
                label="编辑"
                icon={EditIcon}
                disabled={busy}
                onClick={() => {
                  setEditing(t);
                  setName(t.name);
                }}
              />
              <IconButton
                size="small"
                variant="ghost"
                label="删除…"
                icon={TrashIcon}
                disabled={busy}
                onClick={() => setDeleting(t)}
              />
            </div>
          </div>
        ))}
      </div>
      {!tags.length && <Empty text="尚未创建标签" />}
      <ConfirmModal
        open={!!deleting}
        title="删除标签确认"
        message={`删除“${deleting?.name ?? ""}”将移除其设备关联，不影响使用记录。`}
        confirmLabel="确认删除标签"
        danger
        busy={busy}
        closeOnConfirm={false}
        error={error ? errorText(error) : null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void mutate(true)}
      />
    </>
  );
}
type BulkDeviceRow = {
  code: string;
  displayName: string;
  notes: string;
  isDisabled: boolean;
  tagIds: string[];
};

const bulkDeviceLimit = 200;

function parseBulkDeviceJson(raw: string): BulkDeviceRow[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("JSON 格式不正确，请检查括号、引号和逗号。");
  }
  const list = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        Array.isArray((value as { devices?: unknown }).devices)
      ? (value as { devices: unknown[] }).devices
      : null;
  if (!list) throw new Error("请粘贴设备数组，或包含 devices 数组的对象。");
  if (!list.length) throw new Error("JSON 中没有设备。");
  if (list.length > bulkDeviceLimit)
    throw new Error(`一次最多添加 ${bulkDeviceLimit} 台设备。`);
  const seen = new Set<string>();
  return list.map((item, index) => {
    const at = index + 1;
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error(`第 ${at} 项不是对象。`);
    const row = item as Record<string, unknown>;
    const unknown = Object.keys(row).filter(
      (key) =>
        !["code", "displayName", "notes", "isDisabled", "tagIds"].includes(key),
    );
    if (unknown.length)
      throw new Error(`第 ${at} 项包含不支持的字段：${unknown.join("、")}。`);
    const code = typeof row.code === "string" ? row.code.trim() : "";
    if (!code) throw new Error(`第 ${at} 项缺少 code。`);
    if (code.length > 60)
      throw new Error(`第 ${at} 项的 code 超过 60 个字符。`);
    const displayName =
      typeof row.displayName === "string" ? row.displayName.trim() : "";
    if (!displayName) throw new Error(`第 ${at} 项缺少 displayName。`);
    if (displayName.length > 120)
      throw new Error(`第 ${at} 项的 displayName 超过 120 个字符。`);
    const normalized = code.toLocaleLowerCase("en-US");
    if (seen.has(normalized))
      throw new Error(`第 ${at} 项的 code 与前面的设备重复：${code}。`);
    seen.add(normalized);
    const notes = row.notes == null ? "" : row.notes;
    if (typeof notes !== "string" || notes.length > 8000)
      throw new Error(`第 ${at} 项的 notes 必须是 8000 字以内的字符串。`);
    const isDisabled = row.isDisabled == null ? false : row.isDisabled;
    if (typeof isDisabled !== "boolean")
      throw new Error(`第 ${at} 项的 isDisabled 必须是布尔值。`);
    const tagIds = row.tagIds == null ? [] : row.tagIds;
    if (!createDeviceSchema.shape.tagIds.safeParse(tagIds).success)
      throw new Error(`第 ${at} 项的 tagIds 必须是 UUID 字符串数组。`);
    return {
      code,
      displayName,
      notes,
      isDisabled,
      tagIds: tagIds as string[],
    };
  });
}

type BulkDeviceResult = {
  code: string;
  failed?: string;
  pending?: boolean;
};

export function BulkDeviceImport({
  onDone,
  onCancel,
  onBusy,
}: {
  onDone: () => void;
  onCancel: () => void;
  onBusy: (v: boolean) => void;
}) {
  const [raw, setRaw] = useState(""),
    [error, setError] = useState<string>(),
    [running, setRunning] = useState(false),
    [progress, setProgress] = useState({ done: 0, total: 0 }),
    [results, setResults] = useState<BulkDeviceResult[]>([]);
  const finished = results.length > 0 && !running;
  const succeeded = results.filter(
    (result) => !result.failed && !result.pending,
  ).length;
  const pending = results.filter((result) => result.pending).length;
  const failed = results.length - succeeded - pending;
  const close = () => {
    if (running) return;
    if (finished) onDone();
    else onCancel();
  };
  const start = async () => {
    setError(undefined);
    let rows: BulkDeviceRow[];
    try {
      rows = parseBulkDeviceJson(raw);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setResults([]);
    setProgress({ done: 0, total: rows.length });
    setRunning(true);
    onBusy(true);
    const next: BulkDeviceResult[] = [];
    try {
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        try {
          await window.library.call("createDevice", row);
          next.push({ code: row.code });
        } catch (e) {
          if (e instanceof Error && e.message === "COMMAND_PENDING") {
            next.push({ code: row.code, pending: true });
            setResults([...next]);
            setProgress({ done: index + 1, total: rows.length });
            toast.info(
              "提交结果待确认，已停止后续添加，请恢复连接后核对设备列表。",
            );
            return;
          }
          next.push({ code: row.code, failed: errorText(e) });
        }
        setResults([...next]);
        setProgress({ done: index + 1, total: rows.length });
        if (index < rows.length - 1)
          await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const ok = next.filter((result) => !result.failed).length;
      const bad = next.length - ok;
      if (!bad) toast.success(`已添加 ${ok} 台设备`);
      else if (!ok) toast.error(`添加失败 ${bad} 条，请查看列表`);
      else toast.info(`成功 ${ok} 条，失败 ${bad} 条`);
    } finally {
      setRunning(false);
      onBusy(false);
    }
  };
  return (
    <div className="bulk-import">
      <p className="bulk-import-hint">
        粘贴设备 JSON 数组（也支持 <code>{'{"devices":[...]}'}</code>
        ），逐条提交， 最多 {bulkDeviceLimit} 台。<code>code</code>、
        <code>displayName</code> 必填；notes、isDisabled、tagIds（现有标签 UUID
        数组）可选。
      </p>
      <Textarea
        aria-label="批量设备 JSON"
        className="bulk-import-json"
        rows={8}
        value={raw}
        disabled={running || finished}
        onChange={(e) => setRaw(e.target.value)}
        placeholder='[{"code":"A-003","displayName":"三号电脑"}]'
      />
      <pre className="bulk-import-sample">{`[
  { "code": "A-101", "displayName": "新设备一", "notes": "阅览区" },
  { "code": "A-102", "displayName": "新设备二", "isDisabled": true }
]`}</pre>
      {error && <Banner tone="error">{error}</Banner>}
      {running && (
        <div className="bulk-import-progress" aria-live="polite">
          <span>
            正在添加 {progress.done} / {progress.total}
          </span>
          <div>
            <i
              style={{
                width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      )}
      {results.length > 0 && (
        <div className="bulk-import-results" aria-live="polite">
          <b>
            成功 {succeeded} 条，失败 {failed} 条
          </b>
          {pending > 0 && (
            <p>
              待确认 {pending} 条，未发送 {progress.total - progress.done}{" "}
              条。请恢复连接后核对设备列表，再导入剩余项。
            </p>
          )}
          <ul>
            {results.map((result, index) => (
              <li key={`${result.code}-${index}`} data-failed={!!result.failed}>
                <span>{result.code}</span>
                <em>
                  {result.pending
                    ? "提交结果待确认"
                    : (result.failed ?? "已添加")}
                </em>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="form-actions">
        <Button size="small" disabled={running} onClick={close}>
          {finished ? "完成" : "取消"}
        </Button>
        {!finished && (
          <Button
            size="small"
            variant="primary"
            disabled={running || !raw.trim()}
            onClick={() => void start()}
          >
            {running ? "正在添加…" : "开始添加"}
          </Button>
        )}
      </div>
    </div>
  );
}

export function History({
  authenticated,
  tagOptions,
  onModal,
}: {
  authenticated: boolean;
  tagOptions: TagDTO[];
  onModal: (value: boolean) => void;
}) {
  const [data, setData] = useState<PageData<RecordDTO>>({
      items: [],
      total: 0,
      page: 1,
      pageSize: 30,
    }),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [tagId, setTagId] = useState(""),
    [deviceSearch, setDeviceSearch] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [detail, setDetail] = useState<RecordDTO | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const load = async () => {
    if (!authenticated) return;
    setBusy(true);
    try {
      const value = await window.library.call<PageData<RecordDTO>>("history", {
        page,
        pageSize: 30,
        search,
        tagId: tagId || undefined,
        deviceSearch: deviceSearch || undefined,
        from: from ? new Date(from).getTime() : undefined,
        to: to ? new Date(to).getTime() : undefined,
        state: "ended",
      });
      setData(value);
      setError(undefined);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, [page, search, tagId, deviceSearch, from, to, authenticated]);
  useEffect(() => {
    // Do not leave student names and notes visible after the session is lost.
    if (authenticated) return;
    setData({ items: [], total: 0, page: 1, pageSize: 30 });
    setDetail(null);
  }, [authenticated]);
  useEffect(() => {
    onModal(!!detail);
    return () => onModal(false);
  }, [detail]);
  const reset = () => {
    setPage(1);
    setSearch("");
    setTagId("");
    setDeviceSearch("");
    setFrom("");
    setTo("");
  };
  return (
    <Card>
      <div className="card-header">
        <h2>历史记录</h2>
        <span className="muted">{data.total} 条 · 只读</span>
      </div>
      <Toolbar className="history-filters">
        <label className="history-field">
          开始时间从
          <Input
            aria-label="历史开始时间从"
            type="datetime-local"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="history-field">
          至
          <Input
            aria-label="历史开始时间至"
            type="datetime-local"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <Input
          aria-label="搜索学生"
          placeholder="姓名、班级、校内学号"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <Select
          aria-label="历史标签"
          value={tagId}
          onChange={(e) => {
            setTagId(e.target.value);
            setPage(1);
          }}
        >
          <option value="">全部标签</option>
          {tagOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Input
          aria-label="历史设备搜索"
          placeholder="设备名称或编号"
          value={deviceSearch}
          onChange={(e) => {
            setDeviceSearch(e.target.value);
            setPage(1);
          }}
        />
        <IconButton
          size="small"
          variant="ghost"
          label="重置筛选"
          icon={ResetIcon}
          onClick={reset}
        />
        <IconButton
          size="small"
          variant="ghost"
          label="刷新"
          icon={RefreshIcon}
          onClick={() => void load()}
        />
      </Toolbar>
      <Failure error={error} retry={() => void load()} />
      <TableContainer className="table-scroll" aria-busy={busy}>
        <table>
          <thead>
            <tr>
              <th>开始时间</th>
              <th>结束时间</th>
              <th>时长</th>
              <th>学生</th>
              <th>设备</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {busy && !data.items.length
              ? Array.from({ length: 5 }, (_, i) => (
                  <tr key={i}>
                    <td colSpan={6}>
                      <span className="skeleton" />
                    </td>
                  </tr>
                ))
              : data.items.map((r) => (
                  <tr
                    key={r.id}
                    tabIndex={0}
                    className="interactive-row"
                    onClick={() => setDetail(r)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") setDetail(r);
                    }}
                  >
                    <td className="mono">{timestamp(r.startedAtMs)}</td>
                    <td className="mono">{timestamp(r.endedAtMs)}</td>
                    <td className="mono">
                      {duration(r.startedAtMs, r.endedAtMs)}
                    </td>
                    <td>
                      <strong>{r.student.name}</strong>
                      <small>{r.student.className}</small>
                    </td>
                    <td>
                      {r.device.displayName}
                      <small>{r.device.code}</small>
                    </td>
                    <td>
                      <span className="truncate">{r.notes || "—"}</span>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </TableContainer>
      {!busy && !data.items.length && (
        <Empty text="没有符合条件的已结束记录。可调整筛选条件。" />
      )}
      <Pager {...data} page={page} setPage={setPage} />
      {detail && (
        <Dialog
          title="历史记录详情"
          description="学生资料显示最近一次成功刷卡刷新的数据库值。"
          onClose={() => setDetail(null)}
        >
          <dl className="summary">
            <dt>学生</dt>
            <dd>
              {detail.student.name} · {detail.student.className}
              {detail.student.schoolNumber
                ? ` · ${detail.student.schoolNumber}`
                : ""}
            </dd>
            <dt>设备</dt>
            <dd>
              {detail.device.displayName} · {detail.device.code}
            </dd>
            <dt>开始 / 结束</dt>
            <dd>
              {timestamp(detail.startedAtMs)} / {timestamp(detail.endedAtMs)}
            </dd>
            <dt>时长</dt>
            <dd>{duration(detail.startedAtMs, detail.endedAtMs)}</dd>
            <dt>结束方式</dt>
            <dd>
              {detail.endReason === "scan" ? (
                <Badge tone="accent">刷卡</Badge>
              ) : detail.endReason === "batch" ? (
                <Badge tone="neutral">批量</Badge>
              ) : (
                <Badge tone="neutral">手动</Badge>
              )}
            </dd>
            <dt>记录 ID</dt>
            <dd className="mono">{detail.id}</dd>
          </dl>
          <h3>备注</h3>
          <p className="full-notes">{detail.notes || "无备注"}</p>
          <div className="form-actions">
            <Button size="small" onClick={() => setDetail(null)}>
              关闭
            </Button>
          </div>
        </Dialog>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- 相邻试验组 */

const HEX_ID = /^[0-9a-f]{64}$/;
/**
 * 有界整数校验：清空输入在浏览器里读成 0、在 jsdom 里读成 NaN，两种都判为不合法。
 * S1/S3 的判定与服务端共用 protocol 的 `isValidSection1End` / `isValidSection3Start`。
 */
function isValidRange(value: number, min: number, max: number) {
  return Number.isInteger(value) && value >= min && value <= max;
}
/** 数字输入框的受控值：空输入（Number("") = 0 或 NaN）统一以 0 呈现。 */
const finit = (value: number) => (Number.isFinite(value) ? value : 0);
const EXPERIMENT_PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;
/** 一个示例：两个编号 + 它们之间的相邻等级。 */
type PreviewPair = {
  codes: readonly [string, string];
  label: string;
};

/**
 * 预览示例按当前起点生成（docs §1.2 的优先序）。
 *
 * - 区域一/三：四人桌按 `起点 + 0..3` 递增，`1 2`、`3 4` 肩并肩，`3 5` 是相邻两桌的角。
 * - 区域二：`adjacencyGradeOf` 取“第一个有归属的段”作主段落，所以第 1 段写 `0`
 *   才能让这一对只由区域二决定。
 * - 标签取自 `GRADE_LABELS`，不硬编码。
 */
function previewPairs(settings: LayoutSettings): PreviewPair[] {
  const s1 = settings.section1Start;
  const s2 = settings.section2Start;
  const desk = (offset: number) => `${s1 + offset}-0-0`;
  const row = (offset: number) => `0-${s2 + offset}-0`;
  return [
    { codes: [desk(0), desk(1)] as const, label: "并排" },
    { codes: [desk(2), desk(4)] as const, label: "相邻两桌" },
    { codes: [desk(0), desk(2)] as const, label: "面对面" },
    { codes: [row(0), row(1)] as const, label: "长排正对" },
  ];
}

/**
 * 座位布局设置。设置以服务端为准（读写都要求登录），写入带 expectedVersion。
 * 说明文字只给“填什么”，几何规则放在预览里用实际编号展示，不写成段落。
 */
export function LayoutSettingsForm({
  authenticated,
  canWrite,
}: {
  authenticated: boolean;
  canWrite: boolean;
}) {
  const [loaded, setLoaded] = useState(false),
    [version, setVersion] = useState(0),
    [section1Start, setSection1Start] = useState(
      DEFAULT_LAYOUT_SETTINGS.section1Start,
    ),
    [section1End, setSection1End] = useState(
      DEFAULT_LAYOUT_SETTINGS.section1End,
    ),
    [section2Start, setSection2Start] = useState(
      DEFAULT_LAYOUT_SETTINGS.section2Start,
    ),
    [section3Start, setSection3Start] = useState(
      DEFAULT_LAYOUT_SETTINGS.section3Start,
    ),
    [allowCrossArea, setAllowCrossArea] = useState(
      DEFAULT_LAYOUT_SETTINGS.allowCrossArea,
    ),
    [batchWindowSec, setBatchWindowSec] = useState(
      DEFAULT_LAYOUT_SETTINGS.batchWindowSec,
    ),
    [batchStudentLimit, setBatchStudentLimit] = useState(
      DEFAULT_LAYOUT_SETTINGS.batchStudentLimit,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [message, setMessage] = useState("");
  const revision = useRef(0);
  const load = useCallback(async () => {
    if (!authenticated) return;
    const current = ++revision.current;
    try {
      const dto = await window.library.call<LayoutDTO>("layout", {});
      if (current !== revision.current) return;
      const s: LayoutSettings = dto.settings;
      setSection1Start(
        s.section1Start ?? DEFAULT_LAYOUT_SETTINGS.section1Start,
      );
      setSection1End(s.section1End);
      setSection2Start(
        s.section2Start ?? DEFAULT_LAYOUT_SETTINGS.section2Start,
      );
      setSection3Start(s.section3Start);
      setAllowCrossArea(s.allowCrossArea);
      setBatchWindowSec(s.batchWindowSec);
      setBatchStudentLimit(s.batchStudentLimit);
      setVersion(dto.version);
      setError(undefined);
      setLoaded(true);
    } catch (e) {
      if (current === revision.current) setError(e);
    }
  }, [authenticated]);
  useEffect(() => {
    if (!authenticated) {
      revision.current++;
      setLoaded(false);
      return;
    }
    void load();
    return () => {
      revision.current++;
    };
  }, [authenticated, load]);
  // 就地校验：每项一条提示，挂在对应输入框下方；任一不合法即禁用保存。
  const s1StartProblem = !isValidSection1Start(section1Start)
    ? "需为 1–1000 的整数。"
    : "";
  const s1Problem = !isValidSection1End(section1End)
    ? "需为 4 的倍数，8–96。"
    : "";
  const s2StartProblem = !isValidSection2Start(section2Start)
    ? "需为 2–1000 的整数。"
    : "";
  const s3Problem = !isValidSection3Start(section3Start)
    ? "需为 41 + 4n（41、45、49…），41–9960。"
    : "";
  const windowProblem = !isValidRange(batchWindowSec, 10, 600)
    ? "需为 10–600 的整数。"
    : "";
  const limitProblem = !isValidRange(batchStudentLimit, 2, 12)
    ? "需为 2–12 的整数。"
    : "";
  const problems = [
    s1StartProblem,
    s1Problem,
    s2StartProblem,
    s3Problem,
    windowProblem,
    limitProblem,
  ].filter(Boolean);
  const editable = authenticated && canWrite && loaded;
  const save = async () => {
    if (!editable || problems.length || busy) return;
    setBusy(true);
    setError(undefined);
    setMessage("");
    try {
      const dto = await window.library.call<LayoutDTO>("saveLayout", {
        expectedVersion: version,
        section1Start,
        section1End,
        section2Start,
        section3Start,
        allowCrossArea,
        batchWindowSec,
        batchStudentLimit,
      });
      setVersion(dto.version);
      setMessage("已保存。");
    } catch (e) {
      // 版本冲突时以服务端为准重新读取，避免教师继续编辑过期数据；
      // 必须在这之后设置错误，否则 load() 的成功路径会把提示清掉。
      if (e instanceof Error && e.message === "LAYOUT_VERSION_CONFLICT")
        await load();
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    const s = DEFAULT_LAYOUT_SETTINGS;
    setSection1Start(s.section1Start);
    setSection1End(s.section1End);
    setSection2Start(s.section2Start);
    setSection3Start(s.section3Start);
    setAllowCrossArea(s.allowCrossArea);
    setBatchWindowSec(s.batchWindowSec);
    setBatchStudentLimit(s.batchStudentLimit);
    setError(undefined);
    setMessage("已填入默认值，保存后生效。");
  };
  return (
    <SettingsContent>
      {!authenticated ? (
        <Banner tone="warning">请先登录服务器后再读写座位布局。</Banner>
      ) : !loaded ? (
        <p className="muted">正在读取座位布局…</p>
      ) : null}
      <SettingsSection
        title="编号"
        description="设备编号的三段分别对应三个区域。"
      >
        <SettingsRow label="第一组起始编号" description="默认 1">
          <div className="settings-field-stack">
            <Input
              aria-label="第一组起始编号"
              aria-invalid={!!s1StartProblem}
              className="settings-number"
              type="number"
              min={1}
              max={1000}
              disabled={!editable || busy}
              value={finit(section1Start)}
              onChange={(e) => setSection1Start(Number(e.target.value))}
            />
            {s1StartProblem ? <FieldError>{s1StartProblem}</FieldError> : null}
          </div>
        </SettingsRow>
        <SettingsRow label="第一组编号个数" description="4 的倍数，8–96">
          <div className="settings-field-stack">
            <Input
              aria-label="第一组编号个数"
              aria-invalid={!!s1Problem}
              className="settings-number"
              type="number"
              min={8}
              max={96}
              step={4}
              disabled={!editable || busy}
              value={finit(section1End)}
              onChange={(e) => setSection1End(Number(e.target.value))}
            />
            {s1Problem ? <FieldError>{s1Problem}</FieldError> : null}
          </div>
        </SettingsRow>
        <SettingsRow label="第二组起始编号" description="默认 31">
          <div className="settings-field-stack">
            <Input
              aria-label="第二组起始编号"
              aria-invalid={!!s2StartProblem}
              className="settings-number"
              type="number"
              min={2}
              max={1000}
              disabled={!editable || busy}
              value={finit(section2Start)}
              onChange={(e) => setSection2Start(Number(e.target.value))}
            />
            {s2StartProblem ? <FieldError>{s2StartProblem}</FieldError> : null}
          </div>
        </SettingsRow>
        <SettingsRow
          label="第三组起始编号"
          description="默认 41，按 41 + 4n 递增"
        >
          <div className="settings-field-stack">
            <Input
              aria-label="第三组起始编号"
              aria-invalid={!!s3Problem}
              className="settings-number"
              type="number"
              min={41}
              max={9960}
              step={4}
              disabled={!editable || busy}
              value={finit(section3Start)}
              onChange={(e) => setSection3Start(Number(e.target.value))}
            />
            {s3Problem ? <FieldError>{s3Problem}</FieldError> : null}
          </div>
        </SettingsRow>
        <SettingsRow
          label="允许跨区域分配"
          description="关闭后只在同一区域内排座位"
        >
          <Switch
            label=""
            aria-label="允许跨区域分配"
            checked={allowCrossArea}
            disabled={!editable || busy}
            onChange={(e) => setAllowCrossArea(e.target.checked)}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        title="批次"
        description="相邻试验组成员刷卡后的收集窗口。"
      >
        <SettingsRow label="收集窗口（秒）" description="10–600，默认 10">
          <div className="settings-field-stack">
            <Input
              aria-label="批次窗口（秒）"
              aria-invalid={!!windowProblem}
              className="settings-number"
              type="number"
              min={10}
              max={600}
              disabled={!editable || busy}
              value={finit(batchWindowSec)}
              onChange={(e) => setBatchWindowSec(Number(e.target.value))}
            />
            {windowProblem ? <FieldError>{windowProblem}</FieldError> : null}
          </div>
        </SettingsRow>
        <SettingsRow label="单批人数上限" description="2–12，默认 8">
          <div className="settings-field-stack">
            <Input
              aria-label="单批人数上限"
              aria-invalid={!!limitProblem}
              className="settings-number"
              type="number"
              min={2}
              max={12}
              disabled={!editable || busy}
              value={finit(batchStudentLimit)}
              onChange={(e) => setBatchStudentLimit(Number(e.target.value))}
            />
            {limitProblem ? <FieldError>{limitProblem}</FieldError> : null}
          </div>
        </SettingsRow>
      </SettingsSection>
      <LayoutPreview
        settings={{
          section1Start,
          section1End,
          section2Start,
          section3Start,
          allowCrossArea,
          batchWindowSec,
          batchStudentLimit,
        }}
      />
      <Failure error={error} retry={() => void load()} />
      {message && <Banner tone="success">{message}</Banner>}
      {!canWrite && authenticated && (
        <p className="muted">当前不可写入，只能查看。</p>
      )}
      <div className="form-actions">
        <Button
          size="small"
          icon={ResetIcon}
          disabled={!editable || busy}
          onClick={reset}
        >
          填入默认值
        </Button>
        <Button
          size="small"
          icon={RefreshIcon}
          disabled={!authenticated || busy}
          onClick={() => {
            setMessage("");
            setError(undefined);
            void load();
          }}
        >
          重新读取
        </Button>
        <Button
          size="small"
          variant="primary"
          disabled={!editable || busy || problems.length > 0}
          onClick={() => void save()}
        >
          {busy ? "保存中…" : "保存"}
        </Button>
      </div>
    </SettingsContent>
  );
}

/**
 * 相邻关系预览：每个示例一行，左边两个编号，右边等级标签。
 * 不写成规则段落——教师看编号和标签就能判断现场能否讨论。
 */
function LayoutPreview({ settings }: { settings: LayoutSettings }) {
  return (
    <SettingsSection
      title="相邻关系"
      description="按当前编号，两人坐下后能否看到对方屏幕。"
    >
      <ul className="adj-preview">
        {previewPairs(settings).map((pair) => {
          const relation = adjacencyGradeOf(
            pair.codes[0],
            pair.codes[1],
            settings,
          );
          return (
            <li className="adj-preview-row" key={pair.codes.join("/")}>
              <span className="adj-preview-seats">
                <b>{pair.codes[0]}</b>
                <b>{pair.codes[1]}</b>
              </span>
              <span className="adj-preview-note">{pair.label}</span>
              <span className={`adj-preview-grade is-${relation}`}>
                {relation === "none" ? "不相邻" : GRADE_LABELS[relation]}
              </span>
            </li>
          );
        })}
      </ul>
    </SettingsSection>
  );
}

/** 相邻试验组：成员列表 + 按 64 位学生 ID 加入 / 移出。 */
export function ExperimentGroupSettings({
  authenticated,
  canWrite,
}: {
  authenticated: boolean;
  canWrite: boolean;
}) {
  const [data, setData] = useState<PageData<StudentDTO>>({
      items: [],
      total: 0,
      page: 1,
      pageSize: EXPERIMENT_PAGE_SIZE,
    }),
    [loaded, setLoaded] = useState(false),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [debounced, setDebounced] = useState(""),
    [studentId, setStudentId] = useState(""),
    [removing, setRemoving] = useState<StudentDTO | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [formError, setFormError] = useState<string>(),
    [message, setMessage] = useState("");
  const revision = useRef(0);
  useEffect(() => {
    // 搜索输入防抖 300ms，避免每次按键都打一次学生列表接口。
    const timer = setTimeout(
      () => setDebounced(search.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    setPage(1);
  }, [debounced]);
  const load = useCallback(
    async (quiet = false) => {
      if (!authenticated) return;
      const current = ++revision.current;
      if (!quiet) setBusy(true);
      try {
        const value = await window.library.call<PageData<StudentDTO>>(
          "experimentStudents",
          {
            page,
            pageSize: EXPERIMENT_PAGE_SIZE,
            ...(debounced ? { search: debounced } : {}),
          },
        );
        if (current !== revision.current) return;
        setData(value);
        setError(undefined);
        setLoaded(true);
      } catch (e) {
        if (current === revision.current) setError(e);
      } finally {
        if (current === revision.current && !quiet) setBusy(false);
      }
    },
    [authenticated, page, debounced],
  );
  useEffect(() => {
    if (!authenticated) {
      revision.current++;
      setData({ items: [], total: 0, page: 1, pageSize: EXPERIMENT_PAGE_SIZE });
      setLoaded(false);
      setMessage("");
      setFormError(undefined);
      return;
    }
    void load();
    return () => {
      revision.current++;
    };
  }, [authenticated, load]);
  useEffect(() => {
    // 登录失效后不再保留学生姓名。
    if (authenticated) return;
    setData({ items: [], total: 0, page: 1, pageSize: EXPERIMENT_PAGE_SIZE });
    setRemoving(null);
  }, [authenticated]);
  const writable = authenticated && canWrite;
  const normalized = studentId.trim().toLowerCase();
  const idValid = HEX_ID.test(normalized);
  const add = async () => {
    if (!writable || !idValid || busy) return;
    setBusy(true);
    setError(undefined);
    setFormError(undefined);
    setMessage("");
    try {
      await window.library.call("setExperiment", {
        studentId: normalized,
        enabled: true,
      });
      setStudentId("");
      setMessage("已加入。");
      await load(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!removing || !writable || busy) return;
    setBusy(true);
    setError(undefined);
    setMessage("");
    try {
      await window.library.call("setExperiment", {
        studentId: removing.id,
        enabled: false,
      });
      setMessage(`已将 ${removing.name} 移出。`);
      setRemoving(null);
      await load(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <div className="card-header">
        <h2>相邻试验组</h2>
        <span className="muted">{data.total} 人</span>
      </div>
      <Banner tone="info">
        本组成员刷卡后进入批次收集，再刷一次已刷过的卡即结束并分配座位。
      </Banner>
      {!authenticated ? (
        <Banner tone="warning">请先登录服务器后再管理相邻试验组。</Banner>
      ) : null}
      <Toolbar className="history-filters">
        <Input
          aria-label="搜索试验组学生"
          placeholder="姓名、班级、校内学号"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <IconButton
          size="small"
          variant="ghost"
          label="刷新"
          icon={RefreshIcon}
          onClick={() => void load()}
        />
      </Toolbar>
      <Failure error={error} retry={() => void load()} />
      {message && <Banner tone="success">{message}</Banner>}
      <div className="tag-checks">
        <label className="block-label" htmlFor="experiment-student-id">
          添加学生到相邻试验组
        </label>
        <Input
          id="experiment-student-id"
          aria-label="学生 ID"
          aria-invalid={!!studentId.trim() && !idValid}
          placeholder="64 位小写十六进制学生 ID"
          autoComplete="off"
          spellCheck={false}
          disabled={!writable || busy}
          value={studentId}
          onChange={(e) => {
            setStudentId(e.target.value);
            setFormError(undefined);
          }}
        />
        {studentId.trim() && !idValid && (
          <FieldError>需为 64 位小写十六进制。</FieldError>
        )}
        {formError && <FieldError>{formError}</FieldError>}
        <p className="muted">学生 ID 可从“历史记录”的记录详情复制。</p>
        <div className="form-actions">
          <Button
            size="small"
            variant="primary"
            icon={PlusIcon}
            disabled={!writable || busy || !idValid}
            onClick={() => void add()}
          >
            {busy ? "提交中…" : "加入"}
          </Button>
        </div>
      </div>
      <TableContainer className="table-scroll" aria-busy={busy}>
        <table>
          <thead>
            <tr>
              <th>姓名</th>
              <th>班级</th>
              <th>校内学号</th>
              <th>学生 ID</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {busy && !data.items.length
              ? Array.from({ length: 3 }, (_, i) => (
                  <tr key={i}>
                    <td colSpan={5}>
                      <span className="skeleton" />
                    </td>
                  </tr>
                ))
              : data.items.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.name}</strong>
                    </td>
                    <td>{s.className || "—"}</td>
                    <td>{s.schoolNumber || "—"}</td>
                    <td className="mono truncate" title={s.id}>
                      {s.id}
                    </td>
                    <td>
                      <div className="row-actions">
                        <Button
                          size="small"
                          variant="ghost"
                          disabled={!writable || busy}
                          onClick={() => {
                            setError(undefined);
                            setMessage("");
                            setRemoving(s);
                          }}
                        >
                          移出
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </TableContainer>
      {loaded && !data.items.length && (
        <Empty
          text={
            debounced
              ? "没有匹配的试验组成员。"
              : "相邻试验组还没有成员，可用上方输入框添加。"
          }
        />
      )}
      <Pager {...data} page={page} setPage={setPage} />
      <ConfirmModal
        open={!!removing}
        title="移出相邻试验组？"
        message={`${removing?.name ?? ""} 将不再触发多人批次，之后刷卡按普通单人流程处理。`}
        confirmLabel="确认移出"
        busy={busy}
        closeOnConfirm={false}
        error={error ? errorText(error) : null}
        onCancel={() => {
          if (!busy) setRemoving(null);
        }}
        onConfirm={() => void remove()}
      />
    </Card>
  );
}
