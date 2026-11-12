import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  CircleCheck,
  CreditCard,
  LockOpen,
} from "lucide-react";
import { Badge, Banner, Button, Card, Textarea } from "@record/ui";
import type {
  DeviceDTO,
  RecordDTO,
  ScanPreview,
  EndPreview,
  BatchPreview,
  Page,
} from "@record/protocol";
import {
  Dialog,
  Failure,
  Pager,
  LibraryIcon,
  timestamp,
  duration,
} from "./common.js";
import { IdleTimer } from "./timers.js";
type EndFlow = EndPreview | ScanPreview;
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
const classText = (value: string) => value || "—";
const minutes = (start: number, end: number) =>
  Math.max(1, Math.round((end - start) / 60000));
const RING = 100.5;
const IDLE_MS = 10000;
/**
 * 刷卡流程的空闲取消：10 秒无操作即取消，登记与结束相同。计时不依赖窗口
 * 焦点；只有窗口持有焦点时的真实输入才算操作，无焦点一律视为无操作。
 */
function useIdleCancel(active: boolean, onCancel: () => void) {
  const [remaining, setRemaining] = useState(IDLE_MS);
  const timer = useRef<IdleTimer | null>(null);
  useEffect(() => {
    if (!active || timer.current) return;
    const clockTimer = new IdleTimer(() => performance.now(), onCancel);
    timer.current = clockTimer;
    const activity = (e: Event) => {
      if (document.hasFocus()) clockTimer.activity(e.isTrusted);
    };
    const check = () => {
      clockTimer.check();
      setRemaining(clockTimer.remaining());
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
    document.addEventListener("visibilitychange", check, true);
    return () => {
      clockTimer.stop();
      clearInterval(interval);
      for (const name of events)
        document.removeEventListener(name, activity, true);
      document.removeEventListener("visibilitychange", check, true);
    };
  }, [active]);
  return {
    remaining,
    timer,
    /** 提交失败后重新计时，流程保持正常的过期行为。 */
    restart() {
      timer.current?.restart();
      setRemaining(timer.current?.remaining() ?? IDLE_MS);
    },
  };
}
function IdleNotice({ remaining }: { remaining: number }) {
  return (
    <div className="bflow-idle">
      <Ring remaining={remaining} total={IDLE_MS} />
      <div>
        <b>{Math.ceil(remaining / 1000)} 秒无操作将自动取消</b>
        <span>在本窗口点击或输入会重新计时</span>
      </div>
    </div>
  );
}
/** 等待第二次刷卡时的醒目提示。 */
function RescanPrompt({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="bflow-rescan" role="status">
      <CreditCard size={34} aria-hidden="true" />
      <div>
        <b>{title}</b>
        <span>{detail}</span>
      </div>
    </div>
  );
}
function Ring({
  remaining,
  total,
  size = 38,
}: {
  remaining: number | null;
  total: number;
  size?: number;
}) {
  const ratio =
    remaining === null ? 0 : Math.max(0, Math.min(1, remaining / total));
  return (
    <span className="bflow-ring" aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 38 38">
        <circle
          cx="19"
          cy="19"
          r="16"
          fill="none"
          stroke="#f0e8dc"
          strokeWidth="3.5"
        />
        <circle
          cx="19"
          cy="19"
          r="16"
          fill="none"
          stroke="#ffa924"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={RING}
          strokeDashoffset={RING * (1 - ratio)}
          transform="rotate(-90 19 19)"
        />
      </svg>
      <b>{remaining === null ? "–" : Math.ceil(remaining / 1000)}</b>
    </span>
  );
}
export function EndForm({
  preview,
  automatic,
  online = true,
  onDone,
  onCancel,
  onBusy,
  confirmSignal = 0,
}: {
  preview: EndFlow;
  automatic: boolean;
  online?: boolean;
  onDone: () => void;
  onCancel: () => void;
  onBusy: (busy: boolean) => void;
  confirmSignal?: number;
}) {
  const record = preview.record!;
  const [notes, setNotes] = useState(record.notes),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false);
  const idle = useIdleCancel(automatic, onCancel);
  const sent = useRef(false);
  const connected = useRef(online);
  connected.current = online;
  const latest = useRef(notes);
  latest.current = notes;
  const submit = async () => {
    if (sent.current || !connected.current) return;
    // 已过期的刷卡结束只取消，不提交；提交中不再执行空闲取消。
    if (automatic && !idle.timer.current?.submit()) return;
    sent.current = true;
    setBusy(true);
    onBusy(true);
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
      idle.restart();
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  useEffect(() => {
    if (!confirmSignal) return;
    void submit();
  }, [confirmSignal]);
  if (!automatic)
    return (
      <>
        <Card className="student-summary">
          <strong>{record.student.name}</strong>
          <span>{classText(record.student.className)}</span>
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
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <Failure error={error} />
        <div className="form-actions">
          <Button size="small" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button
            size="small"
            variant="primary"
            disabled={busy || !online}
            onClick={() => void submit()}
          >
            {busy ? "确认中…" : "确认结束"}
          </Button>
        </div>
      </>
    );
  return (
    <section className="bflow bflow-end">
      <aside className="bflow-ident">
        <div className="bflow-top">
          <div className="bflow-brand">
            <span className="bflow-mark">
              <LibraryIcon width={17} height={17} />
            </span>
            <div>
              <b>学校图书馆</b>
              <span>· 自助登记</span>
            </div>
          </div>
          <span className={`bflow-online ${online ? "" : "off"}`}>
            <i />
            {online ? "连接正常" : "连接中断"}
          </span>
        </div>
        <div className="bflow-person">
          <span className="bflow-chip">
            <i />
            刷卡结束
          </span>
          <div className="bflow-stack">
            <span className="bflow-k">姓名</span>
            <div className="bflow-value" title={record.student.name}>
              {record.student.name}
            </div>
            <span className="bflow-k">班级</span>
            <div
              className="bflow-value"
              title={record.student.className || undefined}
            >
              {classText(record.student.className)}
            </div>
          </div>
          <div className="bflow-meta">
            <div>
              <span>刷卡时间</span>
              <b>{clock(preview.atMs)}</b>
            </div>
            <div>
              <span>资料刷新</span>
              <b>
                {record.student.refreshedAtMs
                  ? clock(record.student.refreshedAtMs)
                  : "—"}
              </b>
            </div>
          </div>
          <div className="bflow-record">
            <b>{record.device.code}</b>
            <span>{record.device.displayName}</span>
            <em>{clock(record.startedAtMs)} 开始</em>
          </div>
          <div className="bflow-notice">
            <b>记录将保留在历史中</b>
            <span>确认后不可再修改；如需帮助请联系值班教师。</span>
          </div>
        </div>
        <div className="bflow-watermark" aria-hidden="true">
          <CircleCheck size={190} strokeWidth={1.2} />
        </div>
        <div className="bflow-quote">
          <p>期待与你下次再见。</p>
          <span>学校图书馆 · 自助登记终端</span>
        </div>
      </aside>
      <main className="bflow-work">
        <header className="bflow-head">
          <div>
            <p className="bflow-eyebrow">结束使用 · CHECK OUT</p>
            <h1>刷卡结束使用</h1>
            <p className="bflow-sub">
              请确认本次使用信息，再次刷卡确认后记录将结束。
            </p>
          </div>
          <span className="bflow-terminal">
            <i />
            本机登记
          </span>
        </header>
        <div className="bflow-end-body">
          <div className="bflow-duration">
            <div>
              <span>本次使用时长</span>
              <b>{duration(record.startedAtMs, preview.atMs)}</b>
            </div>
            <div className="side">
              <b>约 {minutes(record.startedAtMs, preview.atMs)} 分钟</b>
              <span>记录将保留在历史中</span>
            </div>
          </div>
          <div className="bflow-device-line">
            <b>{record.device.code}</b>
            <span>{record.device.displayName}</span>
          </div>
          <div className="bflow-timeline">
            <div>
              <span>开始</span>
              <b>{clock(record.startedAtMs)}</b>
            </div>
            <div className="arrow">
              <ArrowRight size={15} aria-hidden="true" />
            </div>
            <div className="right">
              <span>结束</span>
              <b>{clock(preview.atMs)}</b>
            </div>
          </div>
          <label className="bflow-notes-label" htmlFor="bflow-end-notes">
            使用备注（可修改）
          </label>
          <textarea
            id="bflow-end-notes"
            aria-label="使用备注"
            className="bflow-notes end"
            value={notes}
            maxLength={8000}
            disabled={busy}
            onChange={(e) => setNotes(e.target.value)}
          />
          <p className="bflow-hint">
            确认后本条记录结束并写入历史，历史记录只读。
          </p>
          <div className="bflow-success">
            <CircleCheck size={15} aria-hidden="true" />
            <span>
              确认后设备 {record.device.code} 将立即释放，其他同学可以继续使用。
            </span>
          </div>
          <Failure error={error} />
        </div>
        <RescanPrompt
          title="请再次刷卡确认结束使用"
          detail={`再刷一次同一张卡即可结束 ${record.device.code}，也可以点击“确认结束”。`}
        />
        <footer className="bflow-foot">
          <IdleNotice remaining={idle.remaining} />
          <div className="bflow-actions">
            <button
              type="button"
              className="bflow-btn"
              disabled={busy}
              onClick={onCancel}
            >
              取消
            </button>
            <button
              type="button"
              className="bflow-btn primary"
              disabled={busy || !online}
              onClick={() => void submit()}
            >
              {busy ? "确认中…" : "确认结束"}
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          </div>
        </footer>
      </main>
    </section>
  );
}
export function Registration({
  preview,
  online = true,
  onDone,
  onCancel,
  onBusy,
  confirmSignal = 0,
}: {
  preview: ScanPreview;
  online?: boolean;
  onDone: (device: DeviceDTO) => void;
  onCancel: () => void;
  onBusy: (busy: boolean) => void;
  confirmSignal?: number;
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
    [located, setLocated] = useState(false),
    [release, setRelease] = useState<EndPreview | null>(null),
    [releaseBusy, setReleaseBusy] = useState(false),
    [releaseError, setReleaseError] = useState<unknown>();
  const sending = useRef(false),
    reveal = useRef(false),
    list = useRef<HTMLDivElement>(null);
  const idle = useIdleCancel(ready, onCancel);
  const timer = idle.timer;
  /**
   * 默认选中第一台可用设备，并定位到它所在的分页。列表按设备编号排序，
   * 第一台可用设备可能排在若干页使用中或禁用的设备之后。
   */
  const locate = async () => {
    try {
      const size = 100;
      for (let index = 1; index <= 20; index++) {
        const r = await window.library.call<{ devices: Page<DeviceDTO> }>(
          "devices",
          { page: index, pageSize: size, state: "all" },
        );
        const position = r.devices.items.findIndex(
          (d) => !d.isDisabled && !d.active,
        );
        if (position >= 0) {
          reveal.current = true;
          setSelected(r.devices.items[position]);
          setPage(
            Math.floor(((index - 1) * size + position) / devices.pageSize) + 1,
          );
          break;
        }
        if (index * size >= r.devices.total) break;
      }
    } catch {
      // 定位失败时退回第一页，下面的列表读取会显示错误。
    }
    setLocated(true);
  };
  useEffect(() => {
    void locate();
  }, []);
  useEffect(() => {
    // 列表渲染后把默认选中的设备滚动到可见区域，只在进入页面时执行一次。
    if (!reveal.current || !selected) return;
    const row = list.current?.querySelector<HTMLElement>(".is-selected");
    if (!row) return;
    reveal.current = false;
    row.scrollIntoView?.({ block: "center" });
  }, [devices, selected]);
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
    if (located) void load();
  }, [located, page, search]);
  const submit = async () => {
    if (!online || release || releaseBusy) return;
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
      onDone(selected);
    } catch (e) {
      setError(e);
      sending.current = false;
      // A retryable rejection must not lock the confirm button forever; re-arm
      // the idle deadline so the preview keeps its normal expiry behavior.
      idle.restart();
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  useEffect(() => {
    if (!confirmSignal) return;
    void submit();
  }, [confirmSignal]);
  const startRelease = async (device: DeviceDTO) => {
    if (!device.active || releaseBusy) return;
    setReleaseBusy(true);
    setReleaseError(undefined);
    try {
      setRelease(
        await window.library.call<EndPreview>("endPreview", {
          recordId: device.active.id,
        }),
      );
    } catch (e) {
      setError(e);
    } finally {
      setReleaseBusy(false);
    }
  };
  const cancelRelease = () => {
    const id = release?.id;
    setRelease(null);
    setReleaseError(undefined);
    if (id)
      void window.library
        .call("cancelPreview", { previewId: id })
        .catch(() => {});
  };
  const confirmRelease = async () => {
    if (!release || releaseBusy) return;
    setReleaseBusy(true);
    setReleaseError(undefined);
    onBusy(true);
    try {
      await window.library.call("end", {
        recordId: release.record.id,
        expectedVersion: release.record.version,
        previewId: release.id,
        notes: release.record.notes,
      });
      setRelease(null);
      setSelected(null);
      await load();
      setError(new Error("TIME_RANGE_CONFLICT"));
    } catch (e) {
      setReleaseError(e);
    } finally {
      setReleaseBusy(false);
      onBusy(false);
    }
  };
  const statusOf = (d: DeviceDTO) =>
    d.isDisabled ? "disabled" : d.active ? "active" : "free";
  const subOf = (d: DeviceDTO) => {
    const tags = d.tags.map((t) => t.name).join(" · ") || "无标签";
    if (d.active) return `${tags} · ${d.active.student.name}使用中`;
    if (d.isDisabled) return `${tags} · ${d.notes || "暂停使用"}`;
    return `${tags} · 可立即使用`;
  };
  return (
    <section className="bflow">
      <aside className="bflow-ident">
        <div className="bflow-top">
          <div className="bflow-brand">
            <span className="bflow-mark">
              <LibraryIcon width={17} height={17} />
            </span>
            <div>
              <b>学校图书馆</b>
              <span>· 自助登记</span>
            </div>
          </div>
          <span className={`bflow-online ${online ? "" : "off"}`}>
            <i />
            {online ? "连接正常" : "连接中断"}
          </span>
        </div>
        <div className="bflow-person">
          <span className="bflow-chip">
            <i />
            刷卡成功
          </span>
          <div className="bflow-stack">
            <span className="bflow-k">姓名</span>
            <div className="bflow-value" title={preview.student.name}>
              {preview.student.name}
            </div>
            <span className="bflow-k">班级</span>
            <div
              className="bflow-value"
              title={preview.student.className || undefined}
            >
              {classText(preview.student.className)}
            </div>
          </div>
          <div className="bflow-meta">
            <div>
              <span>刷卡时间</span>
              <b>{clock(preview.atMs)}</b>
            </div>
            <div>
              <span>资料刷新</span>
              <b>
                {preview.student.refreshedAtMs
                  ? clock(preview.student.refreshedAtMs)
                  : "—"}
              </b>
            </div>
          </div>
          <div className="bflow-leave">
            <CreditCard size={19} aria-hidden="true" />
            <span>离开时请刷卡结束使用</span>
          </div>
        </div>
        <div className="bflow-watermark" aria-hidden="true">
          <BookOpen size={190} strokeWidth={1.2} />
        </div>
        <div className="bflow-quote">
          <p>把时间留给阅读。</p>
          <span>学校图书馆 · 自助登记终端</span>
        </div>
      </aside>
      <main className="bflow-work">
        <header className="bflow-head">
          <div>
            <p className="bflow-eyebrow">使用登记 · REGISTRATION</p>
            <h1>选择设备</h1>
            <p className="bflow-sub">
              已默认选择第一台空闲设备；需要更换时在列表中选择。
            </p>
          </div>
          <span className="bflow-terminal">
            <i />
            本机登记
          </span>
        </header>
        <div className="bflow-tools">
          <input
            className="bflow-input"
            aria-label="搜索可选设备"
            placeholder="搜索设备编号或名称"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          <button
            type="button"
            className="bflow-btn small"
            disabled={busy}
            onClick={() => void load()}
          >
            刷新设备
          </button>
        </div>
        <div className="bflow-list" ref={list}>
          {devices.items.map((d) => {
            const status = statusOf(d);
            return (
              <div
                className={`bflow-row is-${status} ${
                  selected?.id === d.id ? "is-selected" : ""
                }`}
                key={d.id}
              >
                <span className="bflow-code">{d.code}</span>
                <span className="bflow-dev">
                  <b>{d.displayName}</b>
                  <span>{subOf(d)}</span>
                </span>
                <span className={`bflow-state ${status}`}>
                  <i />
                  {status === "active"
                    ? "使用中"
                    : status === "disabled"
                      ? "维护中"
                      : "空闲"}
                </span>
                {d.active ? (
                  <button
                    type="button"
                    className="bflow-release"
                    aria-label={`释放 ${d.code}`}
                    title="释放设备"
                    disabled={busy || releaseBusy}
                    onClick={() => void startRelease(d)}
                  >
                    <LockOpen size={15} aria-hidden="true" />
                  </button>
                ) : d.isDisabled ? (
                  <span className="bflow-noop" aria-hidden="true" />
                ) : (
                  <button
                    type="button"
                    className={`bflow-tick ${
                      selected?.id === d.id ? "on" : ""
                    }`}
                    aria-pressed={selected?.id === d.id}
                    aria-label={`${
                      selected?.id === d.id ? "取消选择" : "选择"
                    } ${d.code}`}
                    disabled={busy}
                    onClick={() =>
                      setSelected(selected?.id === d.id ? null : d)
                    }
                  >
                    {selected?.id === d.id ? (
                      <Check size={13} aria-hidden="true" />
                    ) : null}
                  </button>
                )}
              </div>
            );
          })}
          {ready && !devices.items.length && (
            <p className="bflow-empty">
              没有符合条件的设备，请调整搜索或联系教师添加设备。
            </p>
          )}
          {!ready && <p className="bflow-empty">正在读取设备…</p>}
        </div>
        {devices.total > devices.pageSize && (
          <div className="bflow-pager">
            <Pager {...devices} setPage={setPage} />
          </div>
        )}
        <label className="bflow-notes-label" htmlFor="bflow-start-notes">
          备注（可选）
        </label>
        <textarea
          id="bflow-start-notes"
          aria-label="登记备注"
          className="bflow-notes"
          placeholder="例如：查阅期刊、打印资料…"
          value={notes}
          maxLength={8000}
          disabled={busy}
          onChange={(e) => setNotes(e.target.value)}
        />
        <Failure error={error} />
        {selected ? (
          <RescanPrompt
            title="请再次刷卡确认登记"
            detail={`将登记使用 ${selected.code} ${selected.displayName}。再刷一次同一张卡即可确认，也可以点击“确认登记”。`}
          />
        ) : (
          ready && (
            <RescanPrompt
              title="当前没有可用设备"
              detail="请联系值班教师，或在上方列表中释放一台设备。"
            />
          )
        )}
        <footer className="bflow-foot">
          <IdleNotice remaining={idle.remaining} />
          <div className="bflow-actions">
            <button
              type="button"
              className="bflow-btn"
              disabled={busy}
              onClick={onCancel}
            >
              取消登记
            </button>
            <button
              type="button"
              className="bflow-btn primary"
              disabled={!selected || busy || sending.current || !ready}
              onClick={() => void submit()}
            >
              {busy ? "正在登记…" : "确认登记"}
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          </div>
        </footer>
      </main>
      {release && (
        <Dialog
          title="释放这台设备？"
          description="释放后记录写入历史，无法撤销。"
          width="small"
          onClose={cancelRelease}
        >
          <p className="bflow-release-text">
            将结束 <strong>{release.record.student.name}</strong> 在「
            {release.record.device.displayName} · {release.record.device.code}
            」的当前使用记录。
          </p>
          <Failure error={releaseError} />
          <div className="form-actions">
            <Button size="small" disabled={releaseBusy} onClick={cancelRelease}>
              取消
            </Button>
            <Button
              size="small"
              className="accent-outline"
              disabled={releaseBusy}
              onClick={() => void confirmRelease()}
            >
              {releaseBusy ? "释放中…" : "确认释放"}
            </Button>
          </div>
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
export function NotesEditor({
  record,
  onDone,
  onCancel,
  onBusy,
}: {
  record: RecordDTO;
  onDone: () => void;
  onCancel: () => void;
  onBusy: (v: boolean) => void;
}) {
  const [notes, setNotes] = useState(record.notes),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false);
  return (
    <>
      <label className="block-label" htmlFor="record-notes">
        当前使用备注
      </label>
      <Textarea
        id="record-notes"
        aria-label="当前使用备注"
        value={notes}
        maxLength={8000}
        onChange={(e) => setNotes(e.target.value)}
      />
      <Failure error={error} />
      <div className="form-actions">
        <Button size="small" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button
          size="small"
          variant="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            onBusy(true);
            try {
              await window.library.call("editNotes", {
                recordId: record.id,
                expectedVersion: record.version,
                notes,
              });
              onDone();
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
              onBusy(false);
            }
          }}
        >
          保存备注
        </Button>
      </div>
    </>
  );
}
