import { useEffect, useState } from "react";
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
} from "@record/ui";
import type {
  DeviceDTO,
  TagDTO,
  Page as PageData,
  RecordDTO,
} from "@record/protocol";
import type { LocalStatus } from "../shared/bridge.js";
import type { IdentityConfig } from "@record/protocol/identity";
import type { ReaderProcessConfig } from "../shared/reader-config.js";
import {
  Dialog,
  EditIcon,
  Failure,
  Empty,
  LoginIcon,
  Pager,
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
            ? { kind, reader: acrReader, pollMs: acrPollMs }
            : kind === "external"
              ? { kind, executable }
              : { kind };
      await window.library.call("configureReader", choice);
      setMessage("读卡进程已启动，新配置已覆盖");
      setPort("");
      setAcrReader("");
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
            description="不会结束现有使用；活动设备需先结束记录才能删除。"
          >
            <Switch
              label=""
              aria-label="禁用新登记（不会结束现有使用）"
              checked={disabled}
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
