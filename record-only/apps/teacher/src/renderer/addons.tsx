import { useCallback, useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import { Badge, Banner, Button, Card, Switch } from "@record/ui";
import type { AddonDTO } from "@record/protocol";
import { Dialog, Failure, timestamp } from "./common.js";

/** 从五段 cron 的分钟/小时字段派生展示时间，无法解析时保留原始表达式。 */
function cronClock(cron: string) {
  const [minute, hour] = cron.trim().split(/\s+/);
  const h = Number(hour),
    m = Number(minute);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return cron;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * 内置加载项：状态只从服务器读取，启用/禁用与立即执行都需显式操作。
 * 计划时间与年级筛选属于服务端固定目录，不由教师端硬编码。
 */
export function AddonSettings({
  authenticated,
  canWrite,
}: {
  authenticated: boolean;
  canWrite: boolean;
}) {
  const [items, setItems] = useState<AddonDTO[]>([]),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<AddonDTO | null>(null),
    [message, setMessage] = useState("");
  const revision = useRef(0);
  const load = useCallback(async () => {
    const current = ++revision.current;
    try {
      const response = await window.library.call<{ items: AddonDTO[] }>(
        "addons",
        {},
      );
      if (current !== revision.current) return;
      setItems(response.items);
      setLoaded(true);
    } catch (error) {
      if (current === revision.current) setError(error);
    }
  }, []);
  useEffect(() => {
    if (!authenticated) {
      revision.current++;
      setItems([]);
      setLoaded(false);
      setConfirm(null);
      return;
    }
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 10000);
    return () => {
      clearInterval(timer);
      revision.current++;
    };
  }, [authenticated, load]);
  const toggle = async (addon: AddonDTO) => {
    setBusy(true);
    setError(undefined);
    setMessage("");
    try {
      await window.library.call("configureAddon", {
        addonId: addon.id,
        expectedVersion: addon.version,
        enabled: !addon.enabled,
      });
      setMessage(
        addon.enabled
          ? "加载项已禁用。"
          : "加载项已启用，将从下一个计划时间执行。",
      );
    } catch (error) {
      setError(error);
    } finally {
      await load();
      setBusy(false);
    }
  };
  const runNow = async (addon: AddonDTO) => {
    setBusy(true);
    setError(undefined);
    setMessage("");
    try {
      const result = await window.library.call<{ count: number }>("runAddon", {
        addonId: addon.id,
      });
      setMessage(`已结束 ${result.count} 条使用记录。`);
      setConfirm(null);
    } catch (error) {
      setError(error);
    } finally {
      await load();
      setBusy(false);
    }
  };
  return (
    <Card>
      <h2>内置加载项</h2>
      <p className="muted">
        由服务器独立执行，教师端关闭后仍有效。按北京时间运行，默认禁用。仅结束符合年级的活动记录，保留历史和备注。
      </p>
      {!confirm && (
        <Failure
          error={error}
          retry={() => {
            setError(undefined);
            void load();
          }}
        />
      )}
      {message && <Banner tone="success">{message}</Banner>}
      {!authenticated ? (
        <p>请先登录服务器。</p>
      ) : !loaded ? (
        <p>正在读取加载项…</p>
      ) : (
        items.map((addon) => (
          <section className="addon-row" key={addon.id}>
            <div>
              <h3>
                {addon.name}{" "}
                <Badge tone={addon.enabled ? "success" : "neutral"}>
                  {addon.enabled ? "已启用" : "已禁用"}
                </Badge>
              </h3>
              <p>
                每天 {cronClock(addon.cron)}（{addon.timezone}）
              </p>
              <small>
                {addon.lastRun
                  ? `最近${addon.lastRun.trigger === "cron" ? "定时" : "手动"}执行：${timestamp(addon.lastRun.atMs)}，结束 ${addon.lastRun.count} 条`
                  : "尚未执行"}
              </small>
            </div>
            <div className="row-actions">
              <Switch
                label="启用"
                aria-label={`${addon.enabled ? "禁用" : "启用"} ${addon.name}`}
                checked={addon.enabled}
                disabled={!canWrite || busy}
                onChange={() => void toggle(addon)}
              />
              <Button
                size="small"
                icon={Play}
                disabled={!canWrite || busy || !addon.enabled}
                onClick={() => {
                  setError(undefined);
                  setConfirm(addon);
                }}
              >
                立即执行
              </Button>
            </div>
          </section>
        ))
      )}
      <p className="muted">
        重启或恢复后只补执行当天已启用的到期任务；不影响计划时间后新登记的记录。无法识别或有冲突的年级不会结束。
      </p>
      {confirm && (
        <Dialog
          title="立即执行加载项？"
          onClose={() => {
            if (!busy) setConfirm(null);
          }}
        >
          <p>
            {confirm.name}
            ：立即结束当前符合年级的使用记录，历史保留，结束后不可撤销。
          </p>
          <Failure error={error} />
          <div className="form-actions">
            <Button disabled={busy} onClick={() => setConfirm(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={busy || !canWrite}
              onClick={() => void runNow(confirm)}
            >
              确认执行
            </Button>
          </div>
        </Dialog>
      )}
    </Card>
  );
}
