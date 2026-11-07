import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Card,
  Input,
  PageHeader,
  Textarea,
  Toolbar,
} from "@record/ui";
import type {
  DeviceDTO,
  ScanPreview,
  EndPreview,
  BatchPreview,
  Page,
} from "@record/protocol";
import {
  Dialog,
  Failure,
  Empty,
  Pager,
  StatusBadge,
  timestamp,
  duration,
} from "./common.js";
import { IdleTimer, EndTimer } from "./timers.js";
type EndFlow = EndPreview | ScanPreview;
export function EndForm({
  preview,
  automatic,
  onDone,
  onCancel,
  onBusy,
}: {
  preview: EndFlow;
  automatic: boolean;
  onDone: () => void;
  onCancel: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const record = preview.record!;
  const [notes, setNotes] = useState(record.notes),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false),
    [remaining, setRemaining] = useState<number | null>(
      automatic ? 5000 : null,
    );
  const sent = useRef(false);
  const latest = useRef(notes);
  latest.current = notes;
  const timer = useRef<EndTimer | null>(null);
  const submit = async () => {
    if (sent.current) return;
    sent.current = true;
    setBusy(true);
    onBusy(true);
    timer.current?.stop();
    try {
      await window.library.call("end", {
        recordId: record.id,
        expectedVersion: record.version,
        previewId: preview.id,
        notes: latest.current,
      });
      onDone();
    } catch (e) {
      setError(e);
      sent.current = false;
      setRemaining(null);
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  useEffect(() => {
    if (!automatic) return;
    timer.current = new EndTimer(
      () => performance.now(),
      () => void submit(),
    );
    const tick = setInterval(() => {
      timer.current?.tick();
      setRemaining(timer.current?.remaining() ?? null);
    }, 100);
    const pause = () => {
      timer.current?.pause();
      setRemaining(null);
    };
    window.addEventListener("blur", pause);
    document.addEventListener("visibilitychange", pause);
    return () => {
      clearInterval(tick);
      timer.current?.stop();
      window.removeEventListener("blur", pause);
      document.removeEventListener("visibilitychange", pause);
    };
  }, []);
  return (
    <>
      <Card className="student-summary">
        <strong>{record.student.name}</strong>
        <span>
          {record.student.className} · {record.student.schoolNumber}
        </span>
      </Card>
      <dl className="summary">
        <dt>设备</dt>
        <dd>
          {record.device.displayName} · {record.device.code}
        </dd>
        <dt>开始</dt>
        <dd>{timestamp(record.startedAtMs)}</dd>
        <dt>本次结束</dt>
        <dd>{timestamp(preview.atMs)}</dd>
        <dt>使用时长</dt>
        <dd>{duration(record.startedAtMs, preview.atMs)}</dd>
      </dl>
      <label className="block-label">
        使用备注
        <Textarea
          aria-label="使用备注"
          className="settings-textarea"
          value={notes}
          maxLength={8000}
          disabled={busy}
          onChange={(e) => {
            setNotes(e.target.value);
            timer.current?.pause();
            setRemaining(null);
          }}
        />
      </label>
      <Failure error={error} />
      {automatic && (
        <Banner>
          {remaining === null
            ? "自动确认已暂停。请显式确认或继续倒计时。"
            : `${Math.ceil(remaining / 1000)} 秒后自动结束本条记录`}
        </Banner>
      )}
      <div className={automatic ? "flow-actions" : "form-actions"}>
        <Button size="small" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        {automatic && remaining === null && !error && (
          <Button
            size="small"
            onClick={() => {
              timer.current?.resume();
              setRemaining(5000);
            }}
          >
            继续倒计时
          </Button>
        )}
        <Button
          size="small"
          variant="primary"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? "确认中…" : "确认结束"}
        </Button>
      </div>
    </>
  );
}
export function Registration({
  preview,
  onDone,
  onCancel,
  onBusy,
}: {
  preview: ScanPreview;
  onDone: () => void;
  onCancel: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const [notes, setNotes] = useState(""),
    [selected, setSelected] = useState<DeviceDTO | null>(null),
    [devices, setDevices] = useState<Page<DeviceDTO>>({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    }),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [remaining, setRemaining] = useState(10000),
    [end, setEnd] = useState<EndPreview | null>(null);
  const timer = useRef<IdleTimer | null>(null),
    sending = useRef(false);
  const load = async () => {
    try {
      const r = await window.library.call<{ devices: Page<DeviceDTO> }>(
        "devices",
        { page, pageSize: 20, search, state: "all" },
      );
      setDevices(r.devices);
      setReady(true);
      setError(undefined);
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => {
    void load();
  }, [page, search]);
  useEffect(() => {
    if (!ready || timer.current) return;
    const clock = new IdleTimer(() => performance.now(), onCancel);
    timer.current = clock;
    const activity = (e: Event) => clock.activity(e.isTrusted);
    const check = () => {
      clock.check();
      setRemaining(clock.remaining());
    };
    const events = [
      "keydown",
      "input",
      "click",
      "touchstart",
      "wheel",
      "pointermove",
    ];
    for (const name of events)
      document.addEventListener(name, activity, {
        capture: true,
        passive: true,
      });
    const interval = setInterval(check, 100);
    window.addEventListener("focus", check, true);
    document.addEventListener("visibilitychange", check, true);
    return () => {
      clock.stop();
      clearInterval(interval);
      for (const name of events)
        document.removeEventListener(name, activity, true);
      window.removeEventListener("focus", check, true);
      document.removeEventListener("visibilitychange", check, true);
    };
  }, [ready]);
  const submit = async () => {
    if (sending.current || !selected || !timer.current?.submit()) return;
    sending.current = true;
    setBusy(true);
    onBusy(true);
    try {
      await window.library.call("start", {
        previewId: preview.id,
        deviceId: selected.id,
        notes,
      });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  return (
    <section className="scan-flow-screen scan-registration">
      <PageHeader
        title="登记使用"
        actions={<Badge tone="success">资料已刷新</Badge>}
      />
      <Card className="student-summary">
        <strong>{preview.student.name}</strong>
        <span>
          {preview.student.className} · {preview.student.schoolNumber}
        </span>
      </Card>
      <div className="scan-registration-body">
        <Card className="scan-registration-details">
          <p className="muted">刷卡时间 {timestamp(preview.atMs)}</p>
          <label className="block-label">
            登记备注
            <Textarea
              aria-label="登记备注"
              className="settings-textarea"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={8000}
              disabled={busy}
            />
          </label>
        </Card>
        <Card className="scan-registration-picker">
          <h2>选择设备</h2>
          <Toolbar>
            <Input
              aria-label="搜索可选设备"
              placeholder="搜索编号或设备名称"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
            <Button size="small" onClick={() => void load()}>
              刷新设备
            </Button>
          </Toolbar>
          <div className="picker-list">
            {devices.items.map((d) => {
              const status = d.isDisabled
                ? "disabled"
                : d.active
                  ? "active"
                  : "free";
              return (
                <div
                  className={`picker-row ${selected?.id === d.id ? "selected" : ""}`}
                  key={d.id}
                >
                  <div>
                    <strong>{d.displayName}</strong>
                    <span>
                      {d.code} · {d.tags.map((t) => t.name).join(" / ")}
                    </span>
                  </div>
                  <StatusBadge status={status} />
                  {d.active ? (
                    <Button
                      size="small"
                      disabled={busy}
                      onClick={async () => {
                        try {
                          setEnd(
                            await window.library.call<EndPreview>(
                              "endPreview",
                              { recordId: d.active!.id },
                            ),
                          );
                        } catch (e) {
                          setError(e);
                        }
                      }}
                    >
                      先结束使用…
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      variant={selected?.id === d.id ? "primary" : "secondary"}
                      disabled={busy || d.isDisabled}
                      onClick={() => setSelected(d)}
                    >
                      {selected?.id === d.id ? "已选择" : "选择"}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
          {ready && !devices.items.length && (
            <Empty text="没有可用设备，请调整筛选或联系老师添加设备" />
          )}
          <Pager {...devices} setPage={setPage} />
        </Card>
      </div>
      <Failure error={error} />
      <div className="flow-actions">
        <span className="muted">
          连续 {Math.ceil(remaining / 1000)} 秒无操作后取消
        </span>
        <Button size="small" disabled={busy} onClick={onCancel}>
          取消登记
        </Button>
        <Button
          size="small"
          variant="primary"
          disabled={!selected || busy || sending.current || !ready}
          onClick={() => void submit()}
        >
          {busy ? "正在登记…" : "确认登记"}
        </Button>
      </div>
      {end && (
        <Dialog title="先结束当前使用" onClose={() => setEnd(null)}>
          <EndForm
            preview={end}
            automatic={false}
            onBusy={onBusy}
            onCancel={() => setEnd(null)}
            onDone={() => {
              setEnd(null);
              setSelected(null);
              setError(new Error("TIME_RANGE_CONFLICT"));
              void load();
            }}
          />
        </Dialog>
      )}
    </section>
  );
}
export function BatchForm({
  preview,
  onDone,
  onCancel,
  onBusy,
}: {
  preview: BatchPreview;
  onDone: () => void;
  onCancel: () => void;
  onBusy: (v: boolean) => void;
}) {
  const [notes, setNotes] = useState(""),
    [states, setStates] = useState<string[]>(preview.units.map(() => "待确认")),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const latch = useRef(false);
  const confirm = async () => {
    if (latch.current) return;
    latch.current = true;
    setBusy(true);
    onBusy(true);
    try {
      for (let i = 0; i < preview.units.length; i++) {
        setStates((s) => s.map((v, j) => (j === i ? "提交中" : v)));
        try {
          await window.library.call("batchConfirm", {
            previewId: preview.units[i].id,
            notes,
          });
          setStates((s) => s.map((v, j) => (j === i ? "已完成" : v)));
        } catch (e) {
          setStates((s) => s.map((v, j) => (j === i ? "失败或待确认" : v)));
          throw e;
        }
      }
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
      <Banner tone="warning">
        范围：
        {preview.scope === "all"
          ? "全系统全部活动记录"
          : preview.scope === "selected"
            ? "选中的活动记录"
            : "当前筛选结果"}
        ，共 {preview.total} 条。后来新增的记录不会加入本次操作。
      </Banner>
      <div className="batch-list">
        {preview.units.map((unit, i) => (
          <Card className="batch-unit" key={unit.id}>
            <h3>
              批次 {i + 1} · {unit.records.length} 条 ·{" "}
              <Badge tone={states[i] === "已完成" ? "success" : "neutral"}>
                {states[i]}
              </Badge>
            </h3>
            {unit.records.map((r) => (
              <p key={r.id}>
                {r.device.code} · {r.student.name} · {timestamp(r.startedAtMs)}
              </p>
            ))}
          </Card>
        ))}
      </div>
      {preview.units.length > 1 && (
        <p className="muted">
          每批独立提交，跨批不保证一起成功；失败后保留已完成批次。
        </p>
      )}
      <label className="block-label">
        追加公共备注
        <Textarea
          aria-label="追加公共备注"
          className="settings-textarea"
          maxLength={4000}
          value={notes}
          disabled={busy || latch.current}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <Failure error={error} />
      <div className="form-actions">
        <Button size="small" disabled={busy} onClick={onCancel}>
          {error ? "关闭并刷新" : "取消"}
        </Button>
        <Button
          size="small"
          variant="danger"
          disabled={busy || !preview.total || latch.current}
          onClick={() => void confirm()}
        >
          {busy ? "逐批提交中…" : `确认结束 ${preview.total} 条`}
        </Button>
      </div>
    </>
  );
}
