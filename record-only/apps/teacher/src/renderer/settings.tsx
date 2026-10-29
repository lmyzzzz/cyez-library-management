import { useEffect, useState } from "react";
import { Button, Banner, Field, CheckField } from "@record/ui";
import type { DeviceDTO, TagDTO, Page, RecordDTO } from "@record/protocol";
import type { LocalStatus } from "../shared/bridge.js";
import {
  Dialog,
  Failure,
  Empty,
  Pager,
  timestamp,
  duration,
} from "./common.js";
export function ConnectionForm({
  status,
  refresh,
}: {
  status: LocalStatus | null;
  refresh: () => void;
}) {
  const [ip, setIp] = useState(status?.connection?.ip ?? ""),
    [port, setPort] = useState(status?.connection?.port ?? 443),
    [pin, setPin] = useState(status?.connection?.pin ?? ""),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [remember, setRemember] = useState(false),
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
          await window.library.call("login", { username, password, remember });
          setMessage("登录成功");
        }
      }
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setPassword("");
    }
  };
  return (
    <section className="panel connection">
      <h2>连接配置</h2>
      <p className="muted">
        填写运维提供的服务器地址与叶证书 SHA-256
        指纹。登录信息仅保存在本机系统加密存储中。
      </p>
      <div className="form-grid">
        <Field label="服务器 IP" htmlFor="server-ip">
          <input
            id="server-ip"
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder="例如 192.168.1.10"
          />
        </Field>
        <Field label="HTTPS 端口" htmlFor="server-port">
          <input
            id="server-port"
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
          />
        </Field>
      </div>
      <Field label="叶证书 SHA-256 指纹" htmlFor="server-pin">
        <textarea
          id="server-pin"
          className="fingerprint"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="64 位十六进制，支持冒号分隔"
        />
      </Field>
      <div className="form-grid">
        <Field label="共享账号" htmlFor="username">
          <input
            id="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="密码" htmlFor="password">
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      </div>
      <CheckField
        label="记住登录信息"
        checked={remember}
        onChange={(e) => setRemember(e.target.checked)}
      />
      <Failure error={error} />
      {message && <Banner tone="success">{message}</Banner>}
      <div className="actions">
        <Button disabled={busy} onClick={() => void run("test")}>
          测试连接
        </Button>
        <Button
          variant="primary"
          disabled={busy || !username || !password}
          onClick={() => void run("login")}
        >
          保存并登录
        </Button>
        <Button
          disabled={busy || !status?.savedCredentials}
          onClick={() => void run("saved")}
        >
          使用已保存登录
        </Button>
        <Button disabled={busy} onClick={() => void run("clear")}>
          清除保存项
        </Button>
      </div>
    </section>
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
    <>
      <div className="form-grid">
        <Field label="设备编号" htmlFor="device-code">
          <input
            id="device-code"
            value={code}
            maxLength={60}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        <Field label="设备名称" htmlFor="device-name">
          <input
            id="device-name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </div>
      <label>
        设备备注
        <textarea
          aria-label="设备备注"
          value={notes}
          maxLength={8000}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <CheckField
        label="禁用新登记（不会结束现有使用）"
        checked={disabled}
        onChange={(e) => setDisabled(e.target.checked)}
      />
      <fieldset>
        <legend>筛选标签</legend>
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
      </fieldset>
      <Failure error={error} />
      <div className="actions">
        <Button disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button
          variant="primary"
          disabled={busy || !code.trim() || !name.trim()}
          onClick={() => void save()}
        >
          {busy ? "保存中…" : "保存设备"}
        </Button>
      </div>
    </>
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
      <div className="toolbar">
        <input
          aria-label="标签名称"
          placeholder="标签名称"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button disabled={busy || !name.trim()} onClick={() => void mutate()}>
          {editing ? "保存标签" : "新增标签"}
        </Button>
        {editing && (
          <Button
            onClick={() => {
              setEditing(null);
              setName("");
            }}
          >
            取消编辑
          </Button>
        )}
      </div>
      <Failure error={error} />
      {tags.map((t) => (
        <div className="picker-row" key={t.id}>
          <strong>{t.name}</strong>
          <Button
            disabled={busy}
            onClick={() => {
              setEditing(t);
              setName(t.name);
            }}
          >
            编辑
          </Button>
          <Button
            disabled={busy}
            variant="ghost"
            onClick={() => setDeleting(t)}
          >
            删除…
          </Button>
        </div>
      ))}
      {deleting && (
        <Banner
          tone="warning"
          actions={
            <>
              <Button disabled={busy} onClick={() => setDeleting(null)}>
                取消
              </Button>
              <Button
                disabled={busy}
                variant="danger"
                onClick={() => void mutate(true)}
              >
                确认删除标签
              </Button>
            </>
          }
        >
          删除“{deleting.name}”将移除其设备关联，不影响使用记录。
        </Banner>
      )}
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
  const [data, setData] = useState<Page<RecordDTO>>({
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
      const value = await window.library.call<Page<RecordDTO>>("history", {
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
    <section className="panel">
      <header>
        <h2>历史记录</h2>
        <span className="muted">{data.total} 条 · 只读</span>
      </header>
      <div className="toolbar history-filters">
        <label>
          开始时间从
          <input
            aria-label="历史开始时间从"
            type="datetime-local"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          至
          <input
            aria-label="历史开始时间至"
            type="datetime-local"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <input
          aria-label="搜索学生"
          placeholder="姓名、班级、校内学号"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <select
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
        </select>
        <input
          aria-label="历史设备搜索"
          placeholder="设备名称或编号"
          value={deviceSearch}
          onChange={(e) => {
            setDeviceSearch(e.target.value);
            setPage(1);
          }}
        />
        <Button onClick={reset}>重置筛选</Button>
        <Button onClick={() => void load()}>刷新</Button>
      </div>
      <Failure error={error} retry={() => void load()} />
      <div className="table-scroll" aria-busy={busy}>
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
                    <td className="truncate">{r.notes || "—"}</td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
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
              {detail.student.name} · {detail.student.className} ·{" "}
              {detail.student.schoolNumber}
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
              {detail.endReason === "scan"
                ? "刷卡"
                : detail.endReason === "batch"
                  ? "批量"
                  : "手动"}
            </dd>
            <dt>记录 ID</dt>
            <dd className="mono">{detail.id}</dd>
          </dl>
          <h3>备注</h3>
          <p className="full-notes">{detail.notes || "无备注"}</p>
          <div className="actions">
            <Button onClick={() => setDetail(null)}>关闭</Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
