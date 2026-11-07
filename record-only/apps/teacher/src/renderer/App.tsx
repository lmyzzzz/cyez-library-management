import { useCallback, useEffect, useRef, useState, forwardRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ActionMenu,
  ActionMenuItem,
  AppShell,
  AppToaster,
  Banner,
  Button,
  Card,
  Input,
  Page,
  PageHeader,
  Select,
  TableContainer,
  Textarea,
  Toolbar,
  toast,
} from "@record/ui";
import type { AppRouteRegistration } from "@series/ui";
import type {
  DeviceDTO,
  RecordDTO,
  Page as PageData,
  TagDTO,
  ScanPreview,
  EndPreview,
  BatchPreview,
  ServiceStatus,
} from "@record/protocol";
import type { LocalStatus } from "../shared/bridge.js";
import {
  ConnectionState,
  Dialog,
  EditIcon,
  Empty,
  Failure,
  Pager,
  LibraryIcon,
  SettingsIcon,
  StatusBadge,
  TrashIcon,
  timestamp,
  LiveDuration,
  errorText,
} from "./common.js";
import {
  InitialClientSetup,
  ConnectionForm,
  ReaderSettings,
  DeviceEditor,
  TagManager,
  History,
  ProviderSettingsForm,
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
    [devices, setDevices] = useState<PageData<DeviceDTO>>({
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
    [notice, setNotice] = useState<string>(),
    [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const polling = useRef(false),
    delay = useRef(3000);
  const refreshStatus = useCallback(async () => {
    setStatus(await window.library.call<LocalStatus>("status", {}));
  }, []);
  const load = useCallback(
    async (background = false) => {
      if (polling.current) return;
      polling.current = true;
      if (!background) setLoading(true);
      try {
        const local = await window.library.call<LocalStatus>("status", {});
        setStatus(local);
        if (!local.authenticated) return;
        const [{ devices: d, status: s }, t] = await Promise.all([
          window.library.call<{
            devices: PageData<DeviceDTO>;
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
        if (!background) setLoading(false);
      }
    },
    [page, state, search, tagId, settings],
  );
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let initial = true;
    const poll = async () => {
      if (stopped) return;
      if (!document.hidden && !flow && (!settings || tab === "devices"))
        await load(!initial);
      else await refreshStatus().catch(() => {});
      initial = false;
      if (!stopped) timer = setTimeout(poll, delay.current);
    };
    void poll();
    const visible = () => {
      if (!document.hidden && !flow && (!settings || tab === "devices"))
        void load(true);
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
          setNotice(undefined);
          setFlow(event.preview);
          navigate("/");
        } else if (event.type === "notice") {
          const message = errorText(event.code);
          setNotice(message);
          toast.error(message);
        } else void refreshStatus();
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
  const connectionState = (
    <ConnectionState
      authenticated={!!status?.authenticated}
      online={!!status?.online}
      lastUpdated={lastUpdated}
    />
  );
  const table = (
    <Card>
      <Toolbar className="table-toolbar">
        <Toolbar className="table-toolbar-filters">
          <Input
            aria-label="搜索设备"
            placeholder="搜索设备名称或编号"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
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
          </Select>
          <Button size="small" disabled={loading} onClick={() => void load()}>
            刷新
          </Button>
        </Toolbar>
        <Toolbar className="table-toolbar-actions">
          {settings ? (
            <>
              <Button
                size="small"
                disabled={!canWrite}
                onClick={() => setModal({ kind: "tags" })}
              >
                管理标签
              </Button>
              <Button
                size="small"
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
                size="small"
                disabled={!canWrite || !selected.length}
                onClick={() => void openBatch("selected")}
              >
                结束选中 ({selected.length})
              </Button>
              <Button
                size="small"
                disabled={!canWrite}
                onClick={() => void openBatch("filtered")}
              >
                结束筛选结果…
              </Button>
              <Button
                size="small"
                variant="danger"
                disabled={!canWrite}
                onClick={() => void openBatch("all")}
              >
                结束全部…
              </Button>
            </>
          )}
        </Toolbar>
      </Toolbar>
      {!settings && (
        <div className="tabs" role="group" aria-label="设备状态">
          <Button
            size="small"
            variant={state === "active" ? "primary" : "ghost"}
            onClick={() => setState("active")}
          >
            使用中
          </Button>
          <Button
            size="small"
            variant={state === "free" ? "primary" : "ghost"}
            onClick={() => setState("free")}
          >
            未使用
          </Button>
        </div>
      )}
      <Failure error={error} retry={() => void load()} />
      <TableContainer className="table-scroll" aria-busy={loading}>
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
                    <td colSpan={settings ? 4 : 5}>
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
                      <StatusBadge
                        status={
                          d.isDisabled
                            ? "disabled"
                            : d.active
                              ? "active"
                              : "free"
                        }
                      />
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
                            <LiveDuration startedAtMs={d.active.startedAtMs} />
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
                      {settings ? (
                        <div className="row-actions">
                          <ActionMenu label="设备操作">
                            <ActionMenuItem
                              icon={EditIcon}
                              onSelect={() =>
                                setModal({ kind: "device", device: d })
                              }
                            >
                              编辑
                            </ActionMenuItem>
                            <ActionMenuItem
                              icon={TrashIcon}
                              danger
                              onSelect={() =>
                                setModal({ kind: "delete", device: d })
                              }
                            >
                              删除…
                            </ActionMenuItem>
                          </ActionMenu>
                        </div>
                      ) : d.active ? (
                        <div className="row-actions">
                          <Button
                            size="small"
                            disabled={!canWrite}
                            onClick={() =>
                              setModal({ kind: "notes", record: d.active! })
                            }
                          >
                            备注
                          </Button>
                          <Button
                            size="small"
                            disabled={!canWrite}
                            onClick={() => void end(d.active!.id)}
                          >
                            结束…
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </TableContainer>
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
    </Card>
  );
  if (status && !status.identityConfigured)
    return (
      <AppShell
        routes={routes}
        layout="focus"
        title="图书馆使用登记"
        subtitle="首次配置"
        windowControls={window.windowControls}
      >
        <InitialClientSetup
          onDone={() => {
            navigate("/settings");
            setTab("connection");
            void refreshStatus();
          }}
        />
        <AppToaster />
      </AppShell>
    );
  return (
    <AppShell
      routes={routes}
      layout={flow ? "focus" : undefined}
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
      {flow ? (
        <div className="scan-workspace">
          {notice && (
            <div className="workspace-notice">
              <Banner
                tone="error"
                actions={
                  <Button size="small" onClick={() => setNotice(undefined)}>
                    关闭
                  </Button>
                }
              >
                {notice}
              </Banner>
            </div>
          )}
          {flow.mode === "start" ? (
            <Registration
              key={flow.id}
              preview={flow}
              onDone={done}
              onCancel={closeFlow}
              onBusy={setBusy}
            />
          ) : (
            <section className="scan-flow-screen scan-end">
              <PageHeader title="刷卡结束使用" />
              <EndForm
                key={flow.id}
                preview={flow}
                automatic
                onDone={done}
                onCancel={closeFlow}
                onBusy={setBusy}
              />
            </section>
          )}
        </div>
      ) : (
        <Page>
          <div className="page-stack">
            <PageHeader
              title={settings ? "设置" : "使用登记"}
              actions={connectionState}
            />
            {notice && (
              <Banner
                tone="error"
                actions={
                  <Button size="small" onClick={() => setNotice(undefined)}>
                    关闭
                  </Button>
                }
              >
                {notice}
              </Banner>
            )}
            {__CYEZ_TEST_FEATURES__ &&
              status?.environment !== "production" &&
              status && (
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
                    size="small"
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
                <div className="tabs" role="group" aria-label="设置分类">
                  {[
                    ["connection", "连接配置"],
                    ["reader", "读卡器"],
                    ["provider", "校园数据源"],
                    ["devices", "设备管理"],
                    ["history", "历史记录"],
                    ...(__CYEZ_TEST_FEATURES__
                      ? [["diagnostics", "诊断"]]
                      : []),
                  ].map(([id, name]) => (
                    <Button
                      key={id}
                      size="small"
                      aria-current={tab === id ? "page" : undefined}
                      variant={tab === id ? "primary" : "ghost"}
                      onClick={() => setTab(id)}
                    >
                      {name}
                    </Button>
                  ))}
                </div>
                {tab === "connection" && status && (
                  <ConnectionForm
                    status={status}
                    refresh={() => {
                      void refreshStatus();
                      void load();
                    }}
                  />
                )}
                {tab === "reader" && status && (
                  <ReaderSettings
                    status={status}
                    refresh={() => void refreshStatus()}
                  />
                )}
                {tab === "provider" && (
                  <ProviderSettingsForm
                    authenticated={!!status?.authenticated}
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
                {__CYEZ_TEST_FEATURES__ && tab === "diagnostics" && (
                  <Card>
                    <h2>本机诊断</h2>
                    <dl className="summary">
                      <dt>客户端版本</dt>
                      <dd>{status?.version}</dd>
                      <dt>读卡器</dt>
                      <dd>{status?.reader}</dd>
                      <dt>服务器</dt>
                      <dd>
                        {status?.connectionConfigured ? "已配置" : "未配置"}
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
                    <div className="form-actions">
                      <Button size="small" onClick={() => void refreshStatus()}>
                        刷新诊断
                      </Button>
                    </div>
                  </Card>
                )}
              </>
            ) : (
              <>
                {table}
                {__CYEZ_TEST_FEATURES__ &&
                  status?.environment !== "production" &&
                  status?.authenticated && (
                    <Toolbar className="integration-tools">
                      <span>集成测试读卡器</span>
                      <Button
                        size="small"
                        onClick={() =>
                          void window.library.call("integrationScan", {
                            fixture: "allowed-1",
                          })
                        }
                      >
                        测试卡 1
                      </Button>
                      <Button
                        size="small"
                        onClick={() =>
                          void window.library.call("integrationScan", {
                            fixture: "allowed-2",
                          })
                        }
                      >
                        测试卡 2
                      </Button>
                      <Button
                        size="small"
                        onClick={() =>
                          void window.library.call("integrationScan", {
                            fixture: "unknown",
                          })
                        }
                      >
                        未授权测试卡
                      </Button>
                    </Toolbar>
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
                width={modal.kind === "batch" ? "large" : "medium"}
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
        </Page>
      )}
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
      <div className="form-actions">
        <Button size="small" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button
          size="small"
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
