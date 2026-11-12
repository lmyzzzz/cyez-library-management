import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleCheck, Clock3, FileUp, Inbox, Monitor } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ActionMenu,
  ActionMenuItem,
  AppShell,
  AppToaster,
  Banner,
  Button,
  Card,
  IconButton,
  Input,
  Page,
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
  ChevronRightIcon,
  ConnectionState,
  Dialog,
  EditIcon,
  Empty,
  Failure,
  NoteIcon,
  Pager,
  PlusIcon,
  PowerIcon,
  RefreshIcon,
  StopIcon,
  TagIcon,
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
  BulkDeviceImport,
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
      icon: LibraryIcon,
    },
  },
  {
    id: "settings",
    path: "/settings",
    component: () => null,
    navigation: {
      label: "设置",
      placement: "footer",
      icon: SettingsIcon,
    },
  },
];
type ModalState =
  | { kind: "end"; preview: EndPreview }
  | { kind: "batch"; preview: BatchPreview }
  | { kind: "device"; device: DeviceDTO | null }
  | { kind: "bulkDevices" }
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
    [counts, setCounts] = useState<{
      active: number | null;
      free: number | null;
    }>({ active: null, free: null }),
    [tags, setTags] = useState<TagDTO[]>([]),
    [page, setPage] = useState(1),
    [state, setState] = useState<"active" | "free" | "all">("active"),
    [settingsState, setSettingsState] = useState<"active" | "free" | "all">(
      "all",
    ),
    [search, setSearch] = useState(""),
    [tagId, setTagId] = useState(""),
    [tab, setTab] = useState("connection"),
    [selected, setSelected] = useState<string[]>([]),
    [flow, setFlow] = useState<ScanPreview | null>(null),
    [confirmSignal, setConfirmSignal] = useState(0),
    [modal, setModal] = useState<ModalState>(null),
    [childModal, setChildModal] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState<unknown>(),
    [notice, setNotice] = useState<string>(),
    [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const polling = useRef(false),
    delay = useRef(3000),
    tagsRevision = useRef(0),
    activeFlowId = useRef<string | null>(null);
  const cancelPreview = (previewId: string) => {
    void window.library.call("cancelPreview", { previewId }).catch(() => {});
  };
  useEffect(() => {
    activeFlowId.current = flow?.id ?? null;
  }, [flow?.id]);
  const refreshStatus = useCallback(async () => {
    setStatus(await window.library.call<LocalStatus>("status", {}));
  }, []);
  const refreshTags = useCallback(async () => {
    const revision = ++tagsRevision.current;
    try {
      const t = await window.library.call<{ items: TagDTO[] }>("tags", {});
      if (revision === tagsRevision.current) setTags(t.items);
    } catch {
      // The surrounding load reports the error; this keeps tag edits visible
      // even when a background poll owns the load guard.
    }
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
        // 概览需要同时展示使用中/未使用总数；只在非后台、无筛选时补两次轻量计数。
        const tagsRevisionAtStart = tagsRevision.current;
        const countsTask =
          !settings && !background && !search && !tagId
            ? Promise.all([
                window.library.call<{
                  devices: PageData<DeviceDTO>;
                }>("devices", {
                  page: 1,
                  pageSize: 1,
                  state: "active",
                }),
                window.library.call<{
                  devices: PageData<DeviceDTO>;
                }>("devices", {
                  page: 1,
                  pageSize: 1,
                  state: "free",
                }),
              ])
                .then(([a, f]) => ({
                  active: a.devices.total,
                  free: f.devices.total,
                }))
                .catch(() => null)
            : Promise.resolve(null);
        const [{ devices: d, status: s }, t, countData] = await Promise.all([
          window.library.call<{
            devices: PageData<DeviceDTO>;
            status: ServiceStatus;
          }>("devices", {
            page,
            pageSize: 30,
            state: settings ? settingsState : state,
            search,
            tagId: tagId || undefined,
          }),
          window.library.call<{ items: TagDTO[] }>("tags", {}),
          countsTask,
        ]);
        setDevices(d);
        setService(s);
        setTags(t.items);
        setCounts(
          (prev) =>
            countData ?? (settings ? prev : { ...prev, [state]: d.total }),
        );
        setLastUpdated(Date.now());
        setError(undefined);
        delay.current = 3000;
        await refreshStatus();
      } catch (e) {
        setError(e);
        delay.current = Math.min(30000, delay.current * 2);
        await refreshStatus().catch(() => {});
      } finally {
        polling.current = false;
        if (!background) setLoading(false);
      }
    },
    [page, state, settingsState, search, tagId, settings],
  );
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let initial = true;
    const poll = async () => {
      if (stopped) return;
      try {
        if (!document.hidden && !flow && (!settings || tab === "devices"))
          await load(!initial);
        else await refreshStatus();
      } catch {
        // A single failed refresh must never stop the auto-refresh loop.
      } finally {
        initial = false;
        if (!stopped) timer = setTimeout(poll, delay.current);
      }
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
          setConfirmSignal(0);
          setFlow(event.preview);
          navigate("/");
        } else if (event.type === "confirm") {
          if (activeFlowId.current === event.previewId)
            setConfirmSignal((value) => value + 1);
        } else if (event.type === "notice") {
          const message = errorText(event.code);
          setNotice(message);
          toast.error(message);
        } else void refreshStatus().catch(() => {});
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
  }, [settings, state, settingsState, search, tagId]);
  useEffect(() => {
    // Auth loss invalidates every piece of business data on screen. Skip the
    // initial null status so a first status load does not clear settled data.
    if (status === null || status.authenticated) return;
    setDevices({ items: [], total: 0, page: 1, pageSize: 30 });
    setTags([]);
    setCounts({ active: null, free: null });
    setService(null);
    setFlow(null);
    setSelected([]);
  }, [status?.authenticated]);
  useEffect(() => {
    if (settings && flow) {
      const id = flow.id;
      setFlow(null);
      cancelPreview(id);
    }
  }, [settings]);
  const closeFlow = () => {
    const id = flow?.id;
    setFlow(null);
    if (id) cancelPreview(id);
  };
  const done = () => {
    setFlow(null);
    setModal(null);
    setSelected([]);
    toast.success("操作已完成");
    void load();
  };
  const closeModal = () => {
    // User-initiated close must revoke server-side previews; the success path
    // (`done`) already consumed them and must not cancel.
    if (modal?.kind === "end") cancelPreview(modal.preview.id);
    else if (modal?.kind === "batch")
      for (const unit of modal.preview.units) cancelPreview(unit.id);
    setModal(null);
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
  const nowDate = new Date();
  const clockText = nowDate.toLocaleTimeString("zh-CN", { hour12: false });
  const weekday = "日一二三四五六"[nowDate.getDay()];
  const dateText = `${nowDate.getFullYear()}/${String(
    nowDate.getMonth() + 1,
  ).padStart(
    2,
    "0",
  )}/${String(nowDate.getDate()).padStart(2, "0")} · 周${weekday}`;
  const greeting =
    nowDate.getHours() < 11
      ? "上午好"
      : nowDate.getHours() < 18
        ? "下午好"
        : "晚上好";
  const activeCount =
    counts.active ?? (state === "active" ? devices.total : null);
  const freeCount = counts.free ?? (state === "free" ? devices.total : null);
  const activeLabel =
    activeCount === null ? "—" : String(activeCount).padStart(2, "0");
  const freeLabel =
    freeCount === null ? "—" : String(freeCount).padStart(2, "0");
  const pendingCount = status?.pendingCommands ?? 0;
  const lastSync = lastUpdated
    ? new Date(lastUpdated).toLocaleTimeString("zh-CN", { hour12: false })
    : "—";
  const storageLabel =
    status?.storage === "failed"
      ? "写入失败"
      : status?.storage === "warning"
        ? "空间预警"
        : "正常";
  const pageHeader = (
    <header className="bento-head">
      <div className="bento-heading">
        {!settings && <span className="bento-greet">{greeting}，图书馆</span>}
        <h1>{settings ? "设置" : "使用登记"}</h1>
        <p>
          {settings
            ? "连接、读卡器、设备与历史记录"
            : status?.authenticated
              ? `${activeCount ?? "—"} 台设备正在使用，列表每 3 秒自动刷新。`
              : "等待连接服务器后加载设备。"}
        </p>
      </div>
      <div className="bento-head-side">
        {!settings && (
          <div className="bento-clock">
            <b>{clockText}</b>
            <span>{dateText}</span>
          </div>
        )}
        {connectionState}
        <Button
          size="small"
          variant="primary"
          icon={RefreshIcon}
          disabled={loading}
          onClick={() => void load()}
        >
          刷新数据
        </Button>
      </div>
    </header>
  );
  const table = (
    <Card className="bento-device-card">
      <div className="bento-card-head">
        <h2>{settings ? "设备管理" : "设备使用"}</h2>
        <span className="bento-count">{devices.total} 条</span>
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
        {settings && (
          <div className="tabs" role="group" aria-label="设备状态筛选">
            <Button
              size="small"
              variant={settingsState === "all" ? "primary" : "ghost"}
              onClick={() => setSettingsState("all")}
            >
              全部
            </Button>
            <Button
              size="small"
              variant={settingsState === "active" ? "primary" : "ghost"}
              onClick={() => setSettingsState("active")}
            >
              使用中
            </Button>
            <Button
              size="small"
              variant={settingsState === "free" ? "primary" : "ghost"}
              onClick={() => setSettingsState("free")}
            >
              未使用
            </Button>
          </div>
        )}
      </div>
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
          <IconButton
            size="small"
            variant="ghost"
            label="刷新"
            icon={RefreshIcon}
            disabled={loading}
            onClick={() => void load()}
          />
        </Toolbar>
        <Toolbar className="table-toolbar-actions">
          {settings ? (
            <>
              <IconButton
                size="small"
                variant="ghost"
                label="管理标签"
                icon={TagIcon}
                disabled={!canWrite}
                onClick={() => setModal({ kind: "tags" })}
              />
              <Button
                size="small"
                variant="primary"
                icon={PlusIcon}
                disabled={
                  !canWrite || !service?.allowedActions.includes("modify")
                }
                onClick={() => setModal({ kind: "device", device: null })}
              >
                新增设备
              </Button>
              <Button
                size="small"
                icon={FileUp}
                disabled={
                  !canWrite || !service?.allowedActions.includes("modify")
                }
                onClick={() => setModal({ kind: "bulkDevices" })}
              >
                批量添加
              </Button>
            </>
          ) : (
            <ActionMenu label="批量结束">
              <ActionMenuItem
                icon={StopIcon}
                disabled={!canWrite || !selected.length}
                onSelect={() => void openBatch("selected")}
              >
                结束选中 ({selected.length})
              </ActionMenuItem>
              <ActionMenuItem
                icon={StopIcon}
                disabled={!canWrite}
                onSelect={() => void openBatch("filtered")}
              >
                结束筛选结果…
              </ActionMenuItem>
              <ActionMenuItem
                icon={TrashIcon}
                danger
                disabled={!canWrite}
                onSelect={() => void openBatch("all")}
              >
                结束全部…
              </ActionMenuItem>
            </ActionMenu>
          )}
        </Toolbar>
      </Toolbar>
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
                          <IconButton
                            size="small"
                            variant="ghost"
                            label="备注"
                            icon={NoteIcon}
                            disabled={!canWrite}
                            onClick={() =>
                              setModal({ kind: "notes", record: d.active! })
                            }
                          />
                          <IconButton
                            size="small"
                            variant="ghost"
                            label="结束…"
                            icon={PowerIcon}
                            disabled={!canWrite}
                            onClick={() => void end(d.active!.id)}
                          />
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
        {createPortal(<AppToaster />, document.body)}
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
              online={!!status?.online}
              onDone={done}
              onCancel={closeFlow}
              onBusy={setBusy}
              confirmSignal={confirmSignal}
            />
          ) : (
            <EndForm
              key={flow.id}
              preview={flow}
              automatic
              online={!!status?.online}
              onDone={done}
              onCancel={closeFlow}
              onBusy={setBusy}
              confirmSignal={confirmSignal}
            />
          )}
        </div>
      ) : (
        <Page>
          <div
            className={settings ? "page-stack bento-settings" : "bento-page"}
          >
            {pageHeader}
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
                      <IconButton
                        size="small"
                        variant="ghost"
                        label="刷新诊断"
                        icon={RefreshIcon}
                        onClick={() => void refreshStatus()}
                      />
                    </div>
                  </Card>
                )}
              </>
            ) : (
              <>
                <section className="bento-stats" aria-label="使用概览">
                  <div className="bento-tile hot">
                    <div className="bento-tile-top">
                      <span>正在使用</span>
                      <Monitor aria-hidden="true" />
                    </div>
                    <div className="bento-number">
                      {activeLabel}
                      <small>台</small>
                    </div>
                    <div className="bento-tile-hint">
                      {status?.online ? "数据实时同步" : "等待网络恢复"}
                    </div>
                  </div>
                  <div className="bento-tile">
                    <div className="bento-tile-top">
                      <span>未使用设备</span>
                      <CircleCheck aria-hidden="true" />
                    </div>
                    <div className="bento-number">
                      {freeLabel}
                      <small>台</small>
                    </div>
                    <div className="bento-tile-hint">含维护中设备</div>
                  </div>
                  <div className="bento-tile">
                    <div className="bento-tile-top">
                      <span>待确认提交</span>
                      <Inbox aria-hidden="true" />
                    </div>
                    <div className="bento-number">
                      {pendingCount}
                      <small>条</small>
                    </div>
                    <div className="bento-tile-hint">
                      {pendingCount ? "请先查询原提交" : "没有待处理提交"}
                    </div>
                  </div>
                  <div className="bento-tile">
                    <div className="bento-tile-top">
                      <span>数据同步</span>
                      <Clock3 aria-hidden="true" />
                    </div>
                    <div className="bento-number time">{lastSync}</div>
                    <div className="bento-tile-hint">每 3 秒自动刷新</div>
                  </div>
                </section>
                <div className="bento-grid">
                  <div className="bento-main">
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
                  </div>
                  <aside className="bento-side">
                    <div className="bento-card">
                      <div className="bento-card-head">
                        <h2>终端状态</h2>
                        <span className="bento-live">
                          <i aria-hidden="true" />
                          LIVE
                        </span>
                      </div>
                      <div className="bento-rows">
                        <div>
                          <span>服务器</span>
                          <b className={status?.online ? "ok" : "warn"}>
                            {status?.online
                              ? "连接正常"
                              : status?.authenticated
                                ? "连接中断"
                                : "未登录"}
                          </b>
                        </div>
                        <div>
                          <span>读卡器</span>
                          <b className="truncate" title={status?.reader}>
                            {status?.reader || "未检测"}
                          </b>
                        </div>
                        <div>
                          <span>本地存储</span>
                          <b
                            className={
                              status?.storage === "normal" ? "" : "warn"
                            }
                          >
                            {storageLabel}
                          </b>
                        </div>
                        <div>
                          <span>最近成功</span>
                          <b>{timestamp(status?.lastSuccessMs ?? null)}</b>
                        </div>
                      </div>
                    </div>
                    <div className="bento-card">
                      <div className="bento-card-head">
                        <h2>快捷操作</h2>
                      </div>
                      <div className="bento-quick">
                        <Button
                          size="small"
                          variant="primary"
                          icon={RefreshIcon}
                          disabled={loading}
                          onClick={() => void load()}
                        >
                          刷新数据
                        </Button>
                        <Button
                          size="small"
                          icon={SettingsIcon}
                          onClick={() => navigate("/settings")}
                        >
                          打开设置
                        </Button>
                      </div>
                    </div>
                    <div className="bento-card bento-tip">
                      <div className="bento-card-head">
                        <h2>使用提示</h2>
                      </div>
                      <p>
                        学生刷卡后选择空闲设备；离开时再次刷卡结束使用。10
                        秒无操作会自动取消。
                      </p>
                      <div className="bento-steps">
                        <span>刷卡</span>
                        <ChevronRightIcon aria-hidden="true" />
                        <span>选设备</span>
                        <ChevronRightIcon aria-hidden="true" />
                        <span>确认</span>
                      </div>
                    </div>
                  </aside>
                </div>
                <div className="bento-foot">
                  <span>学校图书馆 · 自助登记终端</span>
                  <span>把时间留给阅读。</span>
                </div>
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
                        : modal.kind === "bulkDevices"
                          ? "批量添加设备"
                          : modal.kind === "delete"
                            ? "删除设备确认"
                            : modal.kind === "notes"
                              ? "编辑活动备注"
                              : "管理标签"
                }
                width={modal.kind === "batch" ? "large" : "medium"}
                onClose={() => {
                  if (!busy) {
                    closeModal();
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
                    onCancel={closeModal}
                  />
                )}
                {modal.kind === "batch" && (
                  <BatchForm
                    preview={modal.preview}
                    onBusy={setBusy}
                    onDone={done}
                    onCancel={() => {
                      closeModal();
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
                {modal.kind === "bulkDevices" && (
                  <BulkDeviceImport
                    onBusy={setBusy}
                    onDone={() => {
                      setModal(null);
                      void load();
                    }}
                    onCancel={() => setModal(null)}
                  />
                )}
                {modal.kind === "tags" && (
                  <TagManager
                    tags={tags}
                    refresh={() => {
                      void refreshTags();
                      void load();
                    }}
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
      {createPortal(<AppToaster />, document.body)}
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
