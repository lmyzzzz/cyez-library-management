import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AppToaster, Button, IconButton, toast } from "@record/ui";
import type {
  DeviceDTO,
  EndPreview,
  Page as PageData,
  RecordDTO,
} from "@record/protocol";
import type { LocalStatus } from "../shared/bridge.js";
import {
  Dialog,
  Failure,
  LiveDuration,
  NoteIcon,
  Pager,
  PowerIcon,
  RefreshIcon,
} from "./common.js";
import { AuxTitleBar } from "./aux-window.js";
import { EndForm, NotesEditor } from "./flows.js";
type Filter = "all" | "active" | "free";
type ModalState =
  | { kind: "notes"; record: RecordDTO }
  | { kind: "end"; preview: EndPreview }
  | null;
const filters: [Filter, string][] = [
  ["all", "全部"],
  ["active", "使用中"],
  ["free", "未使用"],
];
const pageSize = 100;
/**
 * 置顶的使用状态悬浮窗：主窗口设备列表的紧凑副本，可按状态查看、备注和
 * 手动结束使用。不处理刷卡。
 */
export function StatusWindow() {
  const [status, setStatus] = useState<LocalStatus | null>(null),
    [devices, setDevices] = useState<PageData<DeviceDTO>>({
      items: [],
      total: 0,
      page: 1,
      pageSize,
    }),
    [filter, setFilter] = useState<Filter>("all"),
    [page, setPage] = useState(1),
    [modal, setModal] = useState<ModalState>(null),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState<unknown>();
  const request = useRef(0);
  const load = useCallback(async () => {
    const id = ++request.current;
    try {
      const local = await window.library.call<LocalStatus>("status", {});
      if (id !== request.current) return;
      setStatus(local);
      if (!local.authenticated) {
        setDevices({ items: [], total: 0, page: 1, pageSize });
        setModal(null);
        setError(undefined);
        return;
      }
      const result = await window.library.call<{
        devices: PageData<DeviceDTO>;
      }>("devices", { page, pageSize, state: filter });
      if (id !== request.current) return;
      setDevices(result.devices);
      setError(undefined);
    } catch (e) {
      if (id === request.current) setError(e);
    } finally {
      if (id === request.current) setLoaded(true);
    }
  }, [page, filter]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 3000);
    const unsubscribe = window.library.subscribe((event) => {
      if (event.type === "changed") void load();
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [load]);
  const canWrite =
    !!status?.authenticated &&
    !!status.online &&
    status.storage !== "failed" &&
    !busy &&
    !status.pendingCommands;
  const cancelPreview = (previewId: string) =>
    void window.library.call("cancelPreview", { previewId }).catch(() => {});
  const end = async (recordId: string) => {
    setBusy(true);
    try {
      setModal({
        kind: "end",
        preview: await window.library.call<EndPreview>("endPreview", {
          recordId,
        }),
      });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const closeModal = () => {
    if (modal?.kind === "end") cancelPreview(modal.preview.id);
    setModal(null);
  };
  const done = () => {
    setModal(null);
    toast.success("操作已完成");
    void load();
  };
  // 全部设备都在当前页时可以直接数出使用中的数量，无需额外请求。
  const complete = filter === "all" && devices.total <= devices.items.length;
  const activeCount = devices.items.filter((d) => d.active).length;
  const summary = !status?.authenticated
    ? "未登录"
    : !status.online
      ? "连接中断"
      : complete
        ? `使用中 ${activeCount} / ${devices.total}`
        : `${devices.total} 台`;
  return (
    <div className="aux-window status-window">
      <AuxTitleBar title="使用状态" subtitle={summary} />
      <div className="aux-body status-body">
        <div className="status-tools">
          <div className="tabs" role="group" aria-label="设备状态">
            {filters.map(([id, name]) => (
              <Button
                key={id}
                size="small"
                variant={filter === id ? "primary" : "ghost"}
                aria-pressed={filter === id}
                onClick={() => {
                  setFilter(id);
                  setPage(1);
                }}
              >
                {name}
              </Button>
            ))}
          </div>
          <IconButton
            size="small"
            variant="ghost"
            label="刷新"
            icon={RefreshIcon}
            onClick={() => void load()}
          />
        </div>
        <Failure error={error} retry={() => void load()} />
        <ul className="status-list" aria-label="电脑使用状态">
          {devices.items.map((d) => {
            const state = d.isDisabled
              ? "disabled"
              : d.active
                ? "active"
                : "free";
            return (
              <li key={d.id} className={`status-row is-${state}`}>
                <span className="status-code" title={d.displayName}>
                  <i aria-hidden="true" />
                  <b>{d.code}</b>
                  <small>{d.displayName}</small>
                </span>
                {d.active ? (
                  <>
                    <span className="status-user">
                      <b>
                        {d.active.student.name}
                        {d.active.student.className
                          ? ` · ${d.active.student.className}`
                          : ""}
                      </b>
                      <small>
                        <LiveDuration startedAtMs={d.active.startedAtMs} />
                        {d.active.notes ? ` · ${d.active.notes}` : ""}
                      </small>
                    </span>
                    <span className="row-actions">
                      <IconButton
                        size="small"
                        variant="ghost"
                        label={`备注 ${d.code}`}
                        icon={NoteIcon}
                        disabled={!canWrite}
                        onClick={() =>
                          setModal({ kind: "notes", record: d.active! })
                        }
                      />
                      <IconButton
                        size="small"
                        variant="ghost"
                        label={`结束 ${d.code}`}
                        icon={PowerIcon}
                        disabled={!canWrite}
                        onClick={() => void end(d.active!.id)}
                      />
                    </span>
                  </>
                ) : (
                  <span className="status-user">
                    <small>{d.isDisabled ? "禁用" : "空闲"}</small>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {loaded && !devices.items.length && !error && (
          <p className="status-empty">
            {status?.authenticated
              ? "当前分类没有设备。"
              : "请先在管理后台配置连接并登录。"}
          </p>
        )}
        {devices.total > devices.pageSize && (
          <Pager {...devices} page={page} setPage={setPage} />
        )}
      </div>
      {modal && (
        <Dialog
          title={modal.kind === "end" ? "手动结束使用" : "编辑活动备注"}
          onClose={() => {
            if (!busy) closeModal();
          }}
        >
          {modal.kind === "end" ? (
            <EndForm
              preview={modal.preview}
              automatic={false}
              online={!!status?.online}
              onBusy={setBusy}
              onDone={done}
              onCancel={closeModal}
            />
          ) : (
            <NotesEditor
              record={modal.record}
              onDone={done}
              onCancel={() => setModal(null)}
              onBusy={setBusy}
            />
          )}
        </Dialog>
      )}
      {createPortal(<AppToaster />, document.body)}
    </div>
  );
}
