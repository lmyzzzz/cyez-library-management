import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CircleCheck,
  Clock3,
  CreditCard,
  Users,
} from "lucide-react";
import { Banner } from "@record/ui";
import {
  GRADE_RANK,
  type BatchAssignment,
  type BatchSession,
} from "@record/protocol";
import { Failure, LibraryIcon, useClock } from "./common.js";

const classText = (value: string) => value || "—";
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
type BatchStudent = { id: string; name: string };
/** 重试前等待 main 推来 batchAssigned 的最长时间，给出可读的失败反馈。 */
const ASSIGN_TIMEOUT_MS = 15000;

/** 倒计时到 0 后不算结束：服务器会在 closesAtMs 自动确认，这里只显示进行中。 */
function useRemaining(closesAtMs: number) {
  const now = useClock();
  return Math.max(0, closesAtMs - now);
}

/**
 * 批次收集界面（刷卡窗口全屏）。批次真相在 main：本组件只渲染 main 推来的
 * BatchSession，并通过 closeBatch / cancelBatch 请求结束或取消。
 */
export function BatchCollecting({
  session,
  online = true,
  onConfirm,
  onCancel,
  onBusy,
}: {
  session: BatchSession;
  online?: boolean;
  /** 教师主动结束并分配。 */
  onConfirm: () => Promise<void>;
  /** 取消批次（返回等待页）。 */
  onCancel: () => void;
  onBusy?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const sent = useRef(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timeout.current) clearTimeout(timeout.current);
    },
    [],
  );
  const remaining = useRemaining(session.closesAtMs);
  // 进度条以本次批次的窗口长度为分母；快照缺失时至少为 1 毫秒避免除零。
  const windowMs = Math.max(1, session.closesAtMs - session.atMs);
  const closed = remaining === 0 || session.state !== "collecting";
  /**
   * 分配结果由 main 以 `batchAssigned` 事件推送，本组件拿不到它；
   * 这里在“服务端已不再收集”时立刻解除本地锁，避免 15 秒兜底误报。
   */
  const settled = session.state !== "collecting";
  useEffect(() => {
    if (!settled) return;
    if (timeout.current) clearTimeout(timeout.current);
    sent.current = false;
    setBusy(false);
    onBusy?.(false);
  }, [settled]);
  const confirm = async () => {
    if (sent.current || !online || closed) return;
    sent.current = true;
    setBusy(true);
    setError(undefined);
    onBusy?.(true);
    try {
      await onConfirm();
      /*
       * 结束请求成功并不等于拿到分配结果。正常情况下 main 会紧接着推
       * `batchAssigned` 让本组件卸载；只有长时间收不到时才解除锁，让教师
       * 在同一批次上重试。注意这里只解除锁、不报“批次已结束”——分配可能
       * 其实已经成功，误报会让教师以为要重新刷卡。
       */
      timeout.current = setTimeout(() => {
        sent.current = false;
        setBusy(false);
        onBusy?.(false);
      }, ASSIGN_TIMEOUT_MS);
    } catch (e) {
      setError(e);
      sent.current = false;
      setBusy(false);
      onBusy?.(false);
    }
  };
  return (
    <section className="bflow bflow-batch">
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
            试验组成员
          </span>
          <div className="bflow-stack">
            <span className="bflow-k">本批人数</span>
            <div className="bflow-value" data-testid="batch-count">
              {session.students.length} 人
            </div>
            <span className="bflow-k">发起</span>
            <div className="bflow-value">
              {session.students[0]?.name ?? "—"}
            </div>
          </div>
          <div className="bflow-meta">
            <div>
              <span>开始</span>
              <b>{clock(session.atMs)}</b>
            </div>
            <div>
              <span>截止</span>
              <b>{clock(session.closesAtMs)}</b>
            </div>
          </div>
          <div className="bflow-notice">
            <b>截止后自动分配</b>
            <span>也可由教师提前结束。</span>
          </div>
        </div>
        <div className="bflow-watermark" aria-hidden="true">
          <Users size={190} strokeWidth={1.2} />
        </div>
        <div className="bflow-quote">
          <p>把时间留给阅读。</p>
          <span>学校图书馆 · 自助登记终端</span>
        </div>
      </aside>
      <main className="bflow-work">
        <header className="bflow-head">
          <div>
            <p className="bflow-eyebrow">相邻试验组 · GROUP COLLECT</p>
            <h1>请依次刷卡</h1>
            <p className="bflow-sub">已收集的学生会列在下方</p>
          </div>
          <span className="bflow-terminal">
            <i />
            本机登记
          </span>
        </header>
        <div className="batch-countdown" role="timer" aria-live="off">
          <Clock3 size={20} aria-hidden="true" />
          {closed ? (
            <b className="is-closed">正在分配…</b>
          ) : (
            <>
              <b data-testid="batch-remaining">{Math.ceil(remaining / 1000)}</b>
              <span>秒后自动分配</span>
              <i
                className="batch-countdown-bar"
                aria-hidden="true"
                style={{
                  width: `${Math.max(0, Math.min(100, (remaining / windowMs) * 100))}%`,
                }}
              />
            </>
          )}
        </div>
        <div className="bflow-list" aria-live="polite">
          {session.students.map((student, index) => (
            <div className="bflow-row is-selected" key={student.id}>
              <span className="bflow-code">#{index + 1}</span>
              <span className="bflow-dev">
                <b>{student.name}</b>
                <span>{classText(student.className)}</span>
              </span>
              <span className="bflow-state free">
                <i />
                已收集
              </span>
              <span className="bflow-tick on" aria-hidden="true">
                <Check size={13} />
              </span>
            </div>
          ))}
          {!session.students.length && (
            <p className="bflow-empty">还没有成员，请让同学刷卡。</p>
          )}
        </div>
        <div className="bflow-rescan">
          <CreditCard size={34} aria-hidden="true" />
          <div>
            <b>再刷一次已刷过的卡即结束</b>
            <span>已加入 {session.students.length} 人</span>
          </div>
        </div>
        <Failure error={error} />
        <footer className="bflow-foot">
          <div className="bflow-idle">
            <CircleCheck size={16} aria-hidden="true" />
            <div>
              <b>分配会尽量安排相邻座位</b>
              <span>结束后显示每人座位编号。</span>
            </div>
          </div>
          <div className="bflow-actions">
            <button
              type="button"
              className="bflow-btn"
              disabled={busy}
              onClick={onCancel}
            >
              取消批次
            </button>
            <button
              type="button"
              className="bflow-btn primary"
              disabled={busy || closed || !online || !session.students.length}
              onClick={() => void confirm()}
            >
              {busy || closed ? "正在分配…" : "结束批次并分配"}
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          </div>
        </footer>
      </main>
    </section>
  );
}

/**
 * 分配结果界面。等级提示按 protocol 的等级表派生（不写死等级名）：
 * `fair` 提示“只能坐到长桌隔一空位的同排”，`degraded` 提示“面对面/斜对角看不见屏幕”，
 * `clustered`/`scattered` 提示“已尽量集中安排”。
 * busy 与 unresolved 用警示样式列出学生。学生姓名只来自批次的 collect 快照，
 * 结果界面自身不维护任何批次状态。
 */
export function BatchAssigned({
  assignment,
  students = [],
  onDone,
}: {
  assignment: BatchAssignment;
  /** 批次收集阶段的学生快照，用于把 busy / unresolved 的学生 ID 显示成姓名。 */
  students?: BatchStudent[];
  onDone: () => void;
}) {
  // 等级名与排序都来自 protocol，新增/调整等级时这里不需要改。
  const rank = GRADE_RANK[assignment.grade];
  const fairRank = GRADE_RANK.fair;
  const degradedRank = GRADE_RANK.degraded;
  const clusteredRank = GRADE_RANK.clustered;
  const weak = rank >= clusteredRank;
  const fine = !weak && rank === fairRank;
  const degraded = !weak && !fine && rank >= degradedRank;
  const names = new Map(
    students.map((student) => [student.id, student.name] as const),
  );
  const [autoClose, setAutoClose] = useState(true);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    // 与登记结果页一致：5 秒后自动回到等待页，期间学生下一次刷卡会直接顶替。
    if (!autoClose) return;
    const timer = setTimeout(() => done.current(), 5000);
    return () => clearTimeout(timer);
  }, [autoClose]);
  return (
    <section className="bflow bflow-assigned">
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
          <span className="bflow-chip">
            <i />
            分配完成
          </span>
        </div>
        <div className="bflow-person">
          <span className="bflow-k">相邻等级</span>
          <div
            className="bflow-value is-compact"
            data-testid="assignment-grade"
          >
            {assignment.gradeLabel}
          </div>
          <div className="bflow-meta">
            <div>
              <span>人数</span>
              <b>{assignment.assigned.length} 人</b>
            </div>
          </div>
          <div className="bflow-notice">
            <b>{clock(assignment.atMs)} 开始</b>
            <span>离开时请刷卡结束使用。</span>
          </div>
        </div>
        <div className="bflow-watermark" aria-hidden="true">
          <CircleCheck size={190} strokeWidth={1.2} />
        </div>
        <div className="bflow-quote">
          <p>把时间留给阅读。</p>
          <span>学校图书馆 · 自助登记终端</span>
        </div>
      </aside>
      <main className="bflow-work">
        <header className="bflow-head">
          <div>
            <p className="bflow-eyebrow">座位分配 · ASSIGNMENT</p>
            <h1>请按下列座位入座</h1>
            <p className="bflow-sub">按座位号入座</p>
          </div>
          <span className="bflow-terminal">
            <i />
            本机登记
          </span>
        </header>
        {weak ? (
          <Banner tone="warning">没有相邻座位，已尽量集中安排。</Banner>
        ) : degraded ? (
          <Banner tone="warning">
            本批座位看不到对方屏幕，如有可能请调整。
          </Banner>
        ) : fine ? (
          <Banner tone="warning">本批在长桌同排隔了一个空位。</Banner>
        ) : null}
        {(assignment.busy.length > 0 || assignment.unresolved.length > 0) && (
          <Banner tone="error">
            {assignment.busy.length > 0 &&
              `${assignment.busy.length} 位同学已在座使用中，未参与本次分配。`}
            {assignment.busy.length > 0 && assignment.unresolved.length > 0
              ? " "
              : ""}
            {assignment.unresolved.length > 0 &&
              `${assignment.unresolved.length} 位同学没有可用座位，请手动安排。`}
          </Banner>
        )}
        <div className="bflow-list" role="status" aria-live="polite">
          {assignment.assigned.map((seat) => (
            <div
              className="bflow-row is-selected is-assigned"
              key={seat.studentId}
            >
              <span className="bflow-dev">
                <b className="bflow-seat">{seat.code}</b>
                <span>{names.get(seat.studentId) ?? ""}</span>
              </span>
              <span className="bflow-state free">
                <i />
                已分配
              </span>
            </div>
          ))}
          {assignment.busy.map((studentId) => (
            <div className="bflow-row is-disabled" key={`busy-${studentId}`}>
              <span className="bflow-code">在座</span>
              <span className="bflow-dev">
                <b>
                  <AlertTriangle size={15} aria-hidden="true" /> 已在使用设备
                </b>
                <span className="mono">
                  {names.get(studentId) ?? studentId}
                </span>
              </span>
              <span className="bflow-state disabled">
                <i />
                未参与
              </span>
            </div>
          ))}
          {assignment.unresolved.map((studentId) => (
            <div
              className="bflow-row is-disabled"
              key={`unresolved-${studentId}`}
            >
              <span className="bflow-code">无座</span>
              <span className="bflow-dev">
                <b>
                  <AlertTriangle size={15} aria-hidden="true" /> 没有可用座位
                </b>
                <span className="mono">
                  {names.get(studentId) ?? studentId}
                </span>
              </span>
              <span className="bflow-state active">
                <i />
                需手动安排
              </span>
            </div>
          ))}
          {!assignment.assigned.length &&
            !assignment.busy.length &&
            !assignment.unresolved.length && (
              <p className="bflow-empty">本批次没有可分配的学生。</p>
            )}
        </div>
        <footer className="bflow-foot">
          <div className="bflow-idle">
            <Clock3 size={16} aria-hidden="true" />
            <div>
              <b>{autoClose ? "5 秒后返回" : "已暂停自动返回"}</b>
              <span>可停留供学生查看座位。</span>
            </div>
          </div>
          <div className="bflow-actions">
            <button
              type="button"
              className="bflow-btn"
              onClick={() => setAutoClose((value) => !value)}
            >
              {autoClose ? "暂停自动返回" : "恢复自动返回"}
            </button>
            <button
              type="button"
              className="bflow-btn primary"
              onClick={() => done.current()}
            >
              完成
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          </div>
        </footer>
      </main>
    </section>
  );
}
