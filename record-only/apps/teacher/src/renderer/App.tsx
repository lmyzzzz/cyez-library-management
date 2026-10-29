import { useCallback, useEffect, useRef, useState, forwardRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AppShell, Button, Banner, AppToaster, toast } from "@record/ui";
import type { AppRouteRegistration } from "@series/ui";
import type {
  DeviceDTO,
  RecordDTO,
  Page,
  TagDTO,
  ScanPreview,
  EndPreview,
  BatchPreview,
  ServiceStatus,
} from "@record/protocol";
import type { LocalStatus } from "../shared/bridge.js";
import {
  Dialog,
  Failure,
  Empty,
  Pager,
  LibraryIcon,
  SettingsIcon,
  timestamp,
  duration,
  errorText,
  useClock,
} from "./common.js";
import {
  ConnectionForm,
  DeviceEditor,
  TagManager,
  History,
} from "./settings.js";
import { Registration, EndForm, BatchForm } from "./flows.js";
const routes: AppRouteRegistration[] = [
  {
    id: "register",
    path: "/",
    component: () => null,
    navigation: {
      label: "使用登记",
      icon: forwardRef((p, r) => <LibraryIcon {...p} ref={r} />),
    },
  },
  {
    id: "settings",
    path: "/settings",
    component: () => null,
    navigation: {
      label: "设置",
      placement: "footer",
      icon: forwardRef((p, r) => <SettingsIcon {...p} ref={r} />),
    },
  },
];
type ModalState =
  | { kind: "end"; preview: EndPreview }
  | { kind: "batch"; preview: BatchPreview }
  | { kind: "device"; device: DeviceDTO | null }
  | { kind: "delete"; device: DeviceDTO }
  | { kind: "notes"; record: RecordDTO }
  | { kind: "tags" }
  | null;
export function App() {
  const location = useLocation(),
    navigate = useNavigate(),
    settings = location.pathname === "/settings";
  const [status, setStatus] = useState<LocalStatus | null>(null),
    [service, setService] = useState<ServiceStatus | null>(null),
    [devices, setDevices] = useState<Page<DeviceDTO>>({
      items: [],
      total: 0,
      page: 1,
      pageSize: 30,
    }),
    [tags, setTags] = useState<TagDTO[]>([]),
    [page, setPage] = useState(1),
    [state, setState] = useState<"active" | "free" | "all">("active"),
    [search, setSearch] = useState(""),
    [tagId, setTagId] = useState(""),
    [tab, setTab] = useState("connection"),
    [selected, setSelected] = useState<string[]>([]),
    [flow, setFlow] = useState<ScanPreview | null>(null),
    [modal, setModal] = useState<ModalState>(null),
    [childModal, setChildModal] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState<unknown>(),
    [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const polling = useRef(false),
    delay = useRef(3000);
  useClock();
  const refreshStatus = useCallback(async () => {
    setStatus(await window.library.call<LocalStatus>("status", {}));
  }, []);
  const load = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    setLoading(true);
    try {
      const local = await window.library.call<LocalStatus>("status", {});
      setStatus(local);
      if (!local.authenticated) return;
      const [{ devices: d, status: s }, t] = await Promise.all([
        window.library.call<{
          devices: Page<DeviceDTO>;
          status: ServiceStatus;
        }>("devices", {
          page,
          pageSize: 30,
          state: settings ? "all" : state,
          search,
          tagId: tagId || undefined,
        }),
        window.library.call<{ items: TagDTO[] }>("tags", {}),
      ]);
      setDevices(d);
      setService(s);
      setTags(t.items);
      setLastUpdated(Date.now());
      setError(undefined);
      delay.current = 3000;
      await refreshStatus();
    } catch (e) {
      setError(e);
      delay.current = Math.min(30000, delay.current * 2);
      await refreshStatus();
    } finally {
      polling.current = false;
      setLoading(false);
    }
  }, [page, state, search, tagId, settings]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stopped) return;
      if (!document.hidden && !flow && (!settings || tab === "devices"))
        await load();
      else await refreshStatus().catch(() => {});
      if (!stopped) timer = setTimeout(poll, delay.current);
    };
    void poll();
    const visible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load, settings, tab, !!flow]);
  useEffect(
    () =>
      window.library.subscribe((event) => {
        if (event.type === "scan") {
          setFlow(event.preview);
          navigate("/");
        } else if (event.type === "notice") toast.error(errorText(event.code));
        else void refreshStatus();
      }),
    [],
  );
  useEffect(() => {
    void window.library.call("gate", {
      page: settings ? "settings" : flow ? "flow" : "devices",
      modal: !!modal || childModal,
      submitting: busy,
    });
  }, [settings, !!flow, !!modal, childModal, busy]);
  useEffect(() => {
    setSelected([]);
    setPage(1);
  }, [settings, state, search, tagId]);
  useEffect(() => {
    if (settings && flow) {
      const id = flow.id;
      setFlow(null);
      void window.library
        .call("cancelPreview", { previewId: id })
        .catch(() => {});
    }
  }, [settings]);
  const closeFlow = () => {
    const id = flow?.id;
    setFlow(null);
    if (id)
      void window.library
        .call("cancelPreview", { previewId: id })
        .catch(() => {});
  };
  const done = () => {
    setFlow(null);
    setModal(null);
    setSelected([]);
    toast.success("操作已完成");
    void load();
  };
  const canWrite =
    !!status?.authenticated &&
    !!status.online &&
    status.storage !== "failed" &&
    !busy &&
    !status.pendingCommands;
  const openBatch = async (scope: "all" | "selected" | "filtered") => {
    setBusy(true);
    try {
      setModal({
        kind: "batch",
        preview: await window.library.call<BatchPreview>("batchPreview", {
          scope,
          ...(scope === "selected"
            ? { recordIds: selected }
            : scope === "filtered"
              ? { filter: { tagId: tagId || undefined, deviceSearch: search } }
              : {}),
        }),
      });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
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
  const table = (
    <section className="panel">
      <div className="toolbar">
        <input
          aria-label="搜索设备"
          placeholder="搜索设备名称或编号"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="设备标签"
          value={tagId}
          onChange={(e) => setTagId(e.target.value)}
        >
          <option value="">全部标签</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <Button disabled={loading} onClick={() => void load()}>
          刷新
        </Button>
        {settings ? (
          <>
            <Button
              disabled={!canWrite}
              onClick={() => setModal({ kind: "tags" })}
            >
              管理标签
            </Button>
            <Button
              variant="primary"
              disabled={
                !canWrite || !service?.allowedActions.includes("modify")
              }
              onClick={() => setModal({ kind: "device", device: null })}
            >
              新增设备
            </Button>
          </>
        ) : (
          <>
            <Button
              disabled={!canWrite || !selected.length}
              onClick={() => void openBatch("selected")}
            >
              结束选中 ({selected.length})
            </Button>
            <Button
              disabled={!canWrite}
              onClick={() => void openBatch("filtered")}
            >
              结束筛选结果…
            </Button>
            <Button
              variant="danger"
              disabled={!canWrite}
              onClick={() => void openBatch("all")}
            >
              结束全部…
            </Button>
          </>
        )}
      </div>
      {!settings && (
        <div className="tabs" aria-label="设备状态">
          <Button
            variant={state === "active" ? "primary" : "ghost"}
            onClick={() => setState("active")}
          >
            使用中
          </Button>
          <Button
            variant={state === "free" ? "primary" : "ghost"}
            onClick={() => setState("free")}
          >
            未使用
          </Button>
        </div>
      )}
      <Failure error={error} retry={() => void load()} />
      <div className="table-scroll" aria-busy={loading}>
        <table>
          <thead>
            <tr>
              {!settings && <th>选择</th>}
              <th>设备</th>
              <th>标签 / 状态</th>
              <th>{settings ? "设备备注" : "当前使用"}</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && !devices.items.length
              ? Array.from({ length: 5 }, (_, i) => (
                  <tr key={i}>
                    <td colSpan={5}>
                      <span className="skeleton" />
                    </td>
                  </tr>
                ))
              : devices.items.map((d) => (
                  <tr key={d.id}>
                    {!settings && (
                      <td>
                        {d.active && (
                          <input
                            type="checkbox"
                            aria-label={`选择 ${d.code}`}
                            checked={selected.includes(d.active.id)}
                            onChange={(e) =>
                              setSelected(
                                e.target.checked
                                  ? [...selected, d.active!.id]
                                  : selected.filter(
                                      (id) => id !== d.active!.id,
                                    ),
                              )
                            }
                          />
                        )}
                      </td>
                    )}
                    <td>
                      <strong>{d.displayName}</strong>
                      <small>{d.code}</small>
                    </td>
                    <td>
                      <span
                        className={`badge ${d.isDisabled ? "disabled" : d.active ? "active" : "free"}`}
                      >
                        {d.isDisabled ? "禁用" : d.active ? "使用中" : "空闲"}
                      </span>
                      <small>
                        {d.tags.map((t) => t.name).join(" · ") || "无标签"}
                      </small>
                    </td>
                    <td>
                      {settings ? (
                        <span className="truncate">{d.notes || "—"}</span>
                      ) : d.active ? (
                        <>
                          <strong>
                            {d.active.student.name} ·{" "}
                            {d.active.student.className}
                          </strong>
                          <small>
                            {timestamp(d.active.startedAtMs)} ·{" "}
                            {duration(d.active.startedAtMs, null)}
                          </small>
                          <span className="truncate">
                            {d.active.notes || "无备注"}
                          </span>
                        </>
                      ) : (
                        <span className="muted">等待刷卡登记</span>
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        {settings ? (
                          <>
                            <Button
                              disabled={!canWrite}
                              onClick={() =>
                                setModal({ kind: "device", device: d })
                              }
                            >
                              编辑
                            </Button>
                            <Button
                              variant="ghost"
                              disabled={!canWrite}
                              onClick={() =>
                                setModal({ kind: "delete", device: d })
                              }
                            >
                              删除…
                            </Button>
                          </>
                        ) : d.active ? (
                          <>
                            <Button
                              disabled={!canWrite}
                              onClick={() =>
                                setModal({ kind: "notes", record: d.active! })
                              }
                            >
                              备注
                            </Button>
                            <Button
                              disabled={!canWrite}
                              onClick={() => void end(d.active!.id)}
                            >
                              结束…
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {!loading && !devices.items.length && (
        <Empty
          text={
            status?.authenticated
              ? "当前筛选没有设备，可在设置中添加或调整筛选。"
              : "请先在设置中配置连接并登录。"
          }
        />
      )}
      <Pager {...devices} page={page} setPage={setPage} />
    </section>
  );
  return (
    <AppShell
      routes={routes}
      title="图书馆使用登记"
      subtitle={
        status?.authenticated
          ? status.online
            ? "已连接"
            : "连接中断"
          : "未登录"
      }
      windowControls={window.windowControls}
    >
      <div className="workspace-content">
        <div className="page-top">
          <div>
            <p className="eyebrow">SCHOOL LIBRARY</p>
            <h1>{settings ? "设置" : flow ? "使用登记" : "使用登记"}</h1>
          </div>
          <div className="connection-state">
            <span className={`dot ${status?.online ? "online" : ""}`} />
            {status?.online ? "已连接服务器" : "未连接"}
            <small>数据更新 {timestamp(lastUpdated)}</small>
          </div>
        </div>
        {status?.environment !== "production" && status && (
          <Banner tone="warning">
            开发 / 集成环境 ·
            当前使用测试适配器与测试数据；真实校园接口、读卡器和发布验收尚待完成。
          </Banner>
        )}
        {status?.authenticated && !status.online && (
          <Banner tone="error">
            连接已中断，当前显示数据已过期。禁止新业务写入，未确认提交将在重新登录后恢复。
          </Banner>
        )}
        {status?.pendingCommands ? (
          <Banner
            tone="warning"
            actions={
              <Button
                onClick={async () => {
                  try {
                    const r = await window.library.call<{
                      outcomes?: { state: string }[];
                    }>("recover", {});
                    toast.success(
                      `恢复检查完成：${r.outcomes?.length ?? 0} 项`,
                    );
                    void load();
                  } catch (e) {
                    setError(e);
                  }
                }}
              >
                查询原提交
              </Button>
            }
          >
            有 {status.pendingCommands} 条提交结果待确认，请勿重复操作。
          </Banner>
        ) : null}
        {status && status.storage !== "normal" && (
          <Banner tone="warning">
            本地存储{status.storage === "failed" ? "写入失败" : "空间预警"}
            。未确认日志会保留，请处理磁盘空间。
          </Banner>
        )}
        {service && service.mode !== "normal" && (
          <Banner tone="warning">
            服务器存储
            {service.mode === "warning"
              ? "预警"
              : service.mode === "restricted"
                ? "受限：暂停新登记和修改"
                : "写入失败"}
            ，请联系运维。
          </Banner>
        )}
        {settings ? (
          <>
            <nav className="tabs" aria-label="设置分类">
              {[
                ["connection", "连接配置"],
                ["devices", "设备管理"],
                ["history", "历史记录"],
                ["diagnostics", "诊断"],
              ].map(([id, name]) => (
                <Button
                  key={id}
                  variant={tab === id ? "primary" : "ghost"}
                  onClick={() => setTab(id)}
                >
                  {name}
                </Button>
              ))}
            </nav>
            {tab === "connection" && (
              <ConnectionForm
                key={status?.connection?.pin ?? "none"}
                status={status}
                refresh={() => {
                  void refreshStatus();
                  void load();
                }}
              />
            )}
            {tab === "devices" && table}
            {tab === "history" && (
              <History
                authenticated={!!status?.authenticated}
                tagOptions={tags}
                onModal={setChildModal}
              />
            )}
            {tab === "diagnostics" && (
              <section className="panel">
                <h2>本机诊断</h2>
                <dl className="summary">
                  <dt>客户端版本</dt>
                  <dd>{status?.version}</dd>
                  <dt>读卡器</dt>
                  <dd>{status?.reader}</dd>
                  <dt>服务器</dt>
                  <dd>{status?.connection?.ip ?? "未配置"}</dd>
                  <dt>证书指纹</dt>
                  <dd className="fingerprint">
                    {status?.connection?.pin ?? "未配置"}
                  </dd>
                  <dt>待传日志</dt>
                  <dd>
                    {status?.pendingLogs ?? 0} 条 · 最早未确认{" "}
                    {Math.floor((status?.oldestLogAgeMs ?? 0) / 1000)} 秒
                  </dd>
                  <dt>待确认提交</dt>
                  <dd>{status?.pendingCommands ?? 0}</dd>
                  <dt>最近成功连接</dt>
                  <dd>{timestamp(status?.lastSuccessMs ?? null)}</dd>
                </dl>
                <Button onClick={() => void refreshStatus()}>刷新诊断</Button>
              </section>
            )}
          </>
        ) : flow ? (
          flow.mode === "start" ? (
            <Registration
              key={flow.id}
              preview={flow}
              onDone={done}
              onCancel={closeFlow}
              onBusy={setBusy}
            />
          ) : (
            <section className="panel flow">
              <h2>刷卡结束使用</h2>
              <EndForm
                key={flow.id}
                preview={flow}
                automatic
                onDone={done}
                onCancel={closeFlow}
                onBusy={setBusy}
              />
            </section>
          )
        ) : (
          <>
            {table}
            {status?.environment !== "production" && status?.authenticated && (
              <div className="integration-controls">
                <span>集成测试读卡器</span>
                <Button
                  onClick={() =>
                    void window.library.call("integrationScan", {
                      fixture: "allowed-1",
                    })
                  }
                >
                  测试卡 1
                </Button>
                <Button
                  onClick={() =>
                    void window.library.call("integrationScan", {
                      fixture: "allowed-2",
                    })
                  }
                >
                  测试卡 2
                </Button>
                <Button
                  onClick={() =>
                    void window.library.call("integrationScan", {
                      fixture: "unknown",
                    })
                  }
                >
                  未授权测试卡
                </Button>
              </div>
            )}
          </>
        )}
        {modal && (
          <Dialog
            title={
              modal.kind === "end"
                ? "手动结束使用"
                : modal.kind === "batch"
                  ? "批量结束确认"
                  : modal.kind === "device"
                    ? modal.device
                      ? "编辑设备"
                      : "新增设备"
                    : modal.kind === "delete"
                      ? "删除设备确认"
                      : modal.kind === "notes"
                        ? "编辑活动备注"
                        : "管理标签"
            }
            wide={modal.kind === "batch"}
            onClose={() => {
              if (!busy) {
                setModal(null);
                void load();
              }
            }}
          >
            {modal.kind === "end" && (
              <EndForm
                preview={modal.preview}
                automatic={false}
                onBusy={setBusy}
                onDone={done}
                onCancel={() => setModal(null)}
              />
            )}
            {modal.kind === "batch" && (
              <BatchForm
                preview={modal.preview}
                onBusy={setBusy}
                onDone={done}
                onCancel={() => {
                  setModal(null);
                  void load();
                }}
              />
            )}
            {modal.kind === "device" && (
              <DeviceEditor
                device={modal.device}
                tags={tags}
                onBusy={setBusy}
                onDone={done}
                onCancel={() => setModal(null)}
              />
            )}
            {modal.kind === "tags" && (
              <TagManager
                tags={tags}
                refresh={() => void load()}
                onBusy={setBusy}
              />
            )}
            {modal.kind === "delete" && (
              <DeleteDevice
                device={modal.device}
                onDone={done}
                onCancel={() => setModal(null)}
                onBusy={setBusy}
              />
            )}
            {modal.kind === "notes" && (
              <NotesEditor
                record={modal.record}
                onDone={done}
                onCancel={() => setModal(null)}
                onBusy={setBusy}
              />
            )}
          </Dialog>
        )}
      </div>
      <AppToaster />
    </AppShell>
  );
}
function DeleteDevice({
  device,
  onDone,
  onCancel,
  onBusy,
}: {
  device: DeviceDTO;
  onDone: () => void;
  onCancel: () => void;
  onBusy: (v: boolean) => void;
}) {
  const [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false);
  return (
    <>
      <p>
        删除 {device.displayName}（{device.code}
        ）后将不再显示于设备列表，历史记录仍保留。
      </p>
      {device.active && (
        <Banner tone="warning">此设备仍在使用，需要先结束记录。</Banner>
      )}
      <Failure error={error} />
      <div className="actions">
        <Button disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button
          variant="danger"
          disabled={busy || !!device.active}
          onClick={async () => {
            setBusy(true);
            onBusy(true);
            try {
              await window.library.call("deleteDevice", {
                deviceId: device.id,
                expectedVersion: device.version,
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
          确认删除
        </Button>
      </div>
    </>
  );
}
function NotesEditor({
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
      <label>
        当前使用备注
        <textarea
          aria-label="当前使用备注"
          value={notes}
          maxLength={8000}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <Failure error={error} />
      <div className="actions">
        <Button disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button
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
