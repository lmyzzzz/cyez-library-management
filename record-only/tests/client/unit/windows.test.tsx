import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { DeviceDTO, ScanPreview } from "@record/protocol";
import type {
  TeacherEvent,
  LocalStatus,
} from "../../../apps/teacher/src/shared/bridge.js";
import {
  restoreBounds,
  roleAllows,
  windowRole,
} from "../../../apps/teacher/src/shared/windows.js";
import { ScanWindow } from "../../../apps/teacher/src/renderer/ScanWindow.js";
import { StatusWindow } from "../../../apps/teacher/src/renderer/StatusWindow.js";

if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver)
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

const student = {
  id: "a".repeat(64),
  name: "测试学生",
  className: "一班",
  schoolNumber: "T001",
  version: 1,
  refreshedAtMs: Date.now(),
};
const active = {
  id: "record-1",
  student,
  device: { id: "device-1", code: "PC-01", displayName: "一号电脑" },
  startedAtMs: Date.now() - 60000,
  endedAtMs: null,
  notes: "活动备注",
  endReason: null,
  version: 1,
};
const device: DeviceDTO = {
  id: "device-1",
  code: "PC-01",
  displayName: "一号电脑",
  notes: "",
  isDisabled: false,
  deletedAtMs: null,
  version: 1,
  tags: [],
  active,
};
const free: DeviceDTO = {
  ...device,
  id: "device-2",
  code: "PC-02",
  displayName: "二号电脑",
  active: null,
};
const disabled: DeviceDTO = {
  ...free,
  id: "device-3",
  code: "PC-03",
  displayName: "三号电脑",
  isDisabled: true,
};
const status: LocalStatus = {
  identityConfigured: true,
  connectionConfigured: true,
  authenticated: true,
  online: true,
  savedCredentials: false,
  autoLogin: false,
  pendingLogs: 0,
  pendingCommands: 0,
  pendingOtherOrigins: 0,
  oldestLogAgeMs: 0,
  storage: "normal",
  reader: "测试读卡器",
  environment: "integration",
  version: "0.1.0",
  lastSuccessMs: Date.now(),
};
const preview: ScanPreview = {
  id: "preview-1",
  mode: "start",
  student,
  atMs: Date.now(),
  expiresAtMs: Date.now() + 10000,
  record: null,
};
const windows = {
  scanOpen: true,
  statusOpen: true,
  scanFullscreen: false,
  scanAutoFocus: true,
  displayCount: 1,
  scanDisplay: 1,
};
const call = vi.fn<(action: string, input: unknown) => Promise<unknown>>();
let listener: ((event: TeacherEvent) => void) | undefined;
let local = { ...status };
let devices = [device, free, disabled];
beforeEach(() => {
  call.mockReset();
  listener = undefined;
  local = { ...status };
  devices = [device, free, disabled];
  call.mockImplementation(async (action, input) => {
    if (action === "status") return local;
    if (action === "windowState") return windows;
    if (action === "setScanAutoFocus")
      return {
        ...windows,
        scanAutoFocus: (input as { enabled: boolean }).enabled,
      };
    if (action === "devices") {
      const state = (input as { state?: string }).state;
      const items = devices.filter((d) =>
        state === "active" ? d.active : state === "free" ? !d.active : true,
      );
      return {
        devices: { items, total: items.length, page: 1, pageSize: 100 },
        status: { mode: "normal", allowedActions: ["read", "end"] },
      };
    }
    if (action === "endPreview")
      return {
        id: "end-preview",
        mode: "end",
        atMs: Date.now(),
        expiresAtMs: Date.now() + 10000,
        record: active,
      };
    return {};
  });
  Object.defineProperty(window, "library", {
    configurable: true,
    value: {
      call,
      subscribe: (fn: typeof listener) => {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    },
  });
});
afterEach(cleanup);
const titlebar = () =>
  within(document.querySelector<HTMLElement>(".aux-titlebar")!);
const calls = (action: string) =>
  call.mock.calls.filter(([name]) => name === action).map(([, input]) => input);

describe("窗口角色与位置", () => {
  it("刷卡窗口和悬浮窗只开放各自需要的动作，主窗口不再上报门控", () => {
    expect(windowRole("?window=scan")).toBe("scan");
    expect(windowRole("?window=status")).toBe("status");
    expect(windowRole("?window=other")).toBe("main");
    expect(windowRole("")).toBe("main");
    expect(roleAllows("scan", "gate")).toBe(true);
    expect(roleAllows("scan", "start")).toBe(true);
    expect(roleAllows("scan", "setAuxWindow")).toBe(false);
    expect(roleAllows("scan", "configure")).toBe(false);
    expect(roleAllows("scan", "deleteDevice")).toBe(false);
    expect(roleAllows("status", "editNotes")).toBe(true);
    expect(roleAllows("status", "end")).toBe(true);
    expect(roleAllows("status", "gate")).toBe(false);
    expect(roleAllows("status", "start")).toBe(false);
    expect(roleAllows("status", "setAuxWindow")).toBe(false);
    expect(roleAllows("main", "gate")).toBe(false);
    expect(roleAllows("main", "auxCommand")).toBe(false);
    expect(roleAllows("main", "setAuxWindow")).toBe(true);
    expect(roleAllows("main", "integrationScan")).toBe(true);
    for (const action of ["moveScanDisplay", "setScanFullscreen"]) {
      expect(roleAllows("main", action)).toBe(true);
      expect(roleAllows("scan", action)).toBe(false);
      expect(roleAllows("status", action)).toBe(false);
    }
  });

  it("只恢复仍落在某个显示器上的窗口位置，支持副屏和负坐标", () => {
    const primary = { x: 0, y: 0, width: 1920, height: 1040 };
    const left = { x: -1280, y: 0, width: 1280, height: 984 };
    const limits = { minWidth: 320, minHeight: 420, maxWidth: 720 };
    expect(
      restoreBounds(
        { x: -1200, y: 40, width: 400, height: 700, fullscreen: true },
        [primary, left],
        limits,
      ),
    ).toEqual({ x: -1200, y: 40, width: 400, height: 700, fullscreen: true });
    // 副屏被拔掉后回到默认位置。
    expect(
      restoreBounds(
        { x: -1200, y: 40, width: 400, height: 700 },
        [primary],
        limits,
      ),
    ).toBeNull();
    // 标题栏在工作区之外无法拖动。
    expect(
      restoreBounds(
        { x: 100, y: 1030, width: 400, height: 700 },
        [primary],
        limits,
      ),
    ).toBeNull();
    expect(
      restoreBounds(
        { x: 100, y: -30, width: 400, height: 700 },
        [primary],
        limits,
      ),
    ).toBeNull();
    expect(
      restoreBounds(
        { x: 100, y: 100, width: 900, height: 700 },
        [primary],
        limits,
      ),
    ).toEqual({ x: 100, y: 100, width: 720, height: 700, fullscreen: false });
    for (const invalid of [
      null,
      "x",
      { x: 0, y: 0, width: 100, height: 700 },
      { x: 0, y: 0, width: 400, height: 100 },
      { x: 0.5, y: 0, width: 400, height: 700 },
      { x: 0, y: 0, width: 400 },
    ])
      expect(restoreBounds(invalid, [primary], limits)).toBeNull();
  });
});

describe("刷卡窗口", () => {
  it("等待页显示请刷卡并开放门控；流程中关闭门控，取消后恢复并撤销预览", async () => {
    render(<ScanWindow />);
    await screen.findByRole("heading", { name: "请刷卡" });
    await waitFor(() =>
      expect(calls("gate").at(-1)).toEqual({
        page: "devices",
        modal: false,
        submitting: false,
      }),
    );
    act(() => listener?.({ type: "scan", preview }));
    await screen.findByRole("heading", { name: "选择设备" });
    expect(screen.queryByRole("heading", { name: "请刷卡" })).toBeNull();
    await waitFor(() =>
      expect(calls("gate").at(-1)).toMatchObject({ page: "flow" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "取消登记" }));
    await screen.findByRole("heading", { name: "请刷卡" });
    expect(call).toHaveBeenCalledWith("cancelPreview", {
      previewId: preview.id,
    });
    await waitFor(() =>
      expect(calls("gate").at(-1)).toMatchObject({ page: "devices" }),
    );
  });

  it("已取消预览的确认事件不能提交新流程，同预览确认才提交一次", async () => {
    render(<ScanWindow />);
    await screen.findByRole("heading", { name: "请刷卡" });
    act(() => listener?.({ type: "scan", preview }));
    await screen.findByRole("button", { name: "取消选择 PC-02" });
    fireEvent.click(screen.getByRole("button", { name: "取消登记" }));
    act(() => listener?.({ type: "confirm", previewId: preview.id }));
    const next = { ...preview, id: "preview-2" };
    act(() => listener?.({ type: "scan", preview: next }));
    await screen.findByRole("button", { name: "取消选择 PC-02" });
    act(() => listener?.({ type: "confirm", previewId: preview.id }));
    expect(calls("start")).toHaveLength(0);
    act(() => listener?.({ type: "confirm", previewId: next.id }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("start", {
        previewId: next.id,
        deviceId: free.id,
        notes: "",
      }),
    );
    expect(calls("start")).toHaveLength(1);
    // 登记成功页：大字显示学生信息和分配的电脑编号。
    const result = await screen.findByRole("status");
    expect(result.textContent).toContain("登记成功");
    expect(result.textContent).toContain("测试学生");
    expect(result.textContent).toContain("一班");
    expect(result.querySelector(".scan-result-device b")?.textContent).toBe(
      "PC-02",
    );
    await waitFor(() =>
      expect(calls("gate").at(-1)).toMatchObject({ page: "devices" }),
    );
  });

  it("结果页固定 5 秒后关闭，期间的新刷卡立即取代结果页", async () => {
    const end = { ...preview, mode: "end" as const, record: active };
    render(<ScanWindow />);
    await screen.findByRole("heading", { name: "请刷卡" });
    act(() => listener?.({ type: "scan", preview: end }));
    await screen.findByRole("heading", { name: "刷卡结束使用" });
    act(() => listener?.({ type: "confirm", previewId: end.id }));
    await screen.findByRole("heading", { name: "感谢使用" });
    expect(screen.getByRole("status").textContent).toContain("PC-01");
    // 结果页期间收到刷卡：立即进入新流程。
    const next = { ...preview, id: "preview-2" };
    act(() => listener?.({ type: "scan", preview: next }));
    await screen.findByRole("heading", { name: "选择设备" });
    expect(screen.queryByRole("heading", { name: "感谢使用" })).toBeNull();
    await screen.findByRole("button", { name: "取消选择 PC-02" });
    act(() => listener?.({ type: "confirm", previewId: next.id }));
    await screen.findByText("登记成功");
    vi.useFakeTimers();
    try {
      // 重新挂载计时：结果页不等待操作，5 秒后回到等待页。
      act(() => listener?.({ type: "scan", preview: end }));
      act(() => listener?.({ type: "confirm", previewId: end.id }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(screen.getByRole("heading", { name: "感谢使用" })).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4800);
      });
      expect(screen.getByRole("heading", { name: "感谢使用" })).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(screen.getByRole("heading", { name: "请刷卡" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("流程中换卡直接显示新卡的界面；新卡失败时退出旧流程", async () => {
    render(<ScanWindow />);
    await screen.findByRole("heading", { name: "请刷卡" });
    act(() => listener?.({ type: "scan", preview }));
    await screen.findByRole("heading", { name: "选择设备" });
    const other = {
      ...preview,
      id: "preview-other",
      mode: "end" as const,
      student: { ...student, name: "另一位学生" },
      record: { ...active, student: { ...student, name: "另一位学生" } },
    };
    act(() => listener?.({ type: "scan", preview: other }));
    await screen.findByRole("heading", { name: "刷卡结束使用" });
    expect(screen.getAllByText("另一位学生").length).toBeGreaterThan(0);
    // 旧预览的确认不再有效。
    act(() => listener?.({ type: "confirm", previewId: preview.id }));
    expect(calls("start")).toHaveLength(0);
    expect(calls("end")).toHaveLength(0);
    // 另一张无效卡顶替：旧流程取消，回到等待页并提示。
    act(() => {
      listener?.({ type: "cancel", previewId: "unrelated" });
    });
    expect(screen.getByRole("heading", { name: "刷卡结束使用" })).toBeTruthy();
    act(() => {
      listener?.({ type: "cancel", previewId: other.id });
      listener?.({ type: "notice", code: "STUDENT_NOT_ALLOWED" });
    });
    await screen.findByRole("heading", { name: "请刷卡" });
    await waitFor(() =>
      expect(
        document.querySelector("[data-sonner-toast]")?.textContent,
      ).toContain("校园资料服务未确认"),
    );
  });

  it("刷卡结束流程在本窗口显示；非等待页的刷卡只弹出 toast", async () => {
    render(<ScanWindow />);
    await screen.findByRole("heading", { name: "请刷卡" });
    act(() =>
      listener?.({
        type: "scan",
        preview: { ...preview, mode: "end", record: active },
      }),
    );
    await screen.findByRole("heading", { name: "刷卡结束使用" });
    act(() => listener?.({ type: "notice", code: "SCAN_RETURN_TO_DEVICES" }));
    await waitFor(() =>
      expect(
        document.querySelector("[data-sonner-toast]")?.textContent,
      ).toContain("请先完成或取消当前操作"),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("heading", { name: "刷卡结束使用" })).toBeTruthy();
  });

  it("勾选框切换自动前台，全屏、最小化和设置按钮发送窗口命令", async () => {
    render(<ScanWindow />);
    const box =
      await screen.findByLabelText<HTMLInputElement>("刷卡时自动切到前台");
    await waitFor(() => expect(box.checked).toBe(true));
    fireEvent.click(box);
    await waitFor(() => expect(box.checked).toBe(false));
    expect(call).toHaveBeenCalledWith("setScanAutoFocus", { enabled: false });
    fireEvent.click(screen.getByRole("button", { name: "全屏" }));
    expect(call).toHaveBeenCalledWith("auxCommand", {
      command: "toggleFullscreen",
    });
    act(() =>
      listener?.({
        type: "windows",
        state: { ...windows, scanFullscreen: true },
      }),
    );
    expect(screen.getByRole("button", { name: "退出全屏" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    fireEvent.click(screen.getByRole("button", { name: "窗口设置" }));
    expect(calls("auxCommand")).toEqual([
      { command: "toggleFullscreen" },
      { command: "minimize" },
      { command: "openSettings" },
    ]);
    expect(titlebar().queryByRole("button", { name: /关闭/ })).toBeNull();
  });

  it("未登录时提示无法刷卡，登录失效会退出进行中的流程", async () => {
    render(<ScanWindow />);
    await screen.findByRole("heading", { name: "请刷卡" });
    act(() => listener?.({ type: "scan", preview }));
    await screen.findByRole("heading", { name: "选择设备" });
    local = { ...status, authenticated: false, online: false };
    act(() => listener?.({ type: "changed" }));
    await screen.findByRole("heading", { name: "暂时无法刷卡" });
    expect(screen.getAllByText(/尚未登录服务器/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "选择设备" })).toBeNull();
  });
});

describe("状态悬浮窗", () => {
  it("紧凑列出全部设备并按全部、使用中、未使用分类", async () => {
    render(<StatusWindow />);
    await screen.findByText("PC-01");
    expect(screen.getByText("测试学生 · 一班")).toBeTruthy();
    expect(screen.getByText("空闲")).toBeTruthy();
    expect(screen.getByText("禁用")).toBeTruthy();
    expect(screen.getByText("使用中 1 / 3")).toBeTruthy();
    expect(calls("devices").at(-1)).toMatchObject({ state: "all" });
    fireEvent.click(screen.getByRole("button", { name: "使用中" }));
    await waitFor(() => expect(screen.queryByText("PC-02")).toBeNull());
    expect(calls("devices").at(-1)).toMatchObject({ state: "active" });
    fireEvent.click(screen.getByRole("button", { name: "未使用" }));
    await waitFor(() => expect(screen.queryByText("PC-01")).toBeNull());
    expect(screen.getByText("PC-02")).toBeTruthy();
    expect(calls("devices").at(-1)).toMatchObject({ state: "free" });
    expect(calls("gate")).toHaveLength(0);
  });

  it("可备注和手动结束使用，取消结束会撤销预览", async () => {
    render(<StatusWindow />);
    fireEvent.click(await screen.findByRole("button", { name: "备注 PC-01" }));
    fireEvent.change(screen.getByLabelText("当前使用备注"), {
      target: { value: "更新备注" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存备注" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "editNotes",
        expect.objectContaining({ recordId: active.id, notes: "更新备注" }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("当前使用备注")).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "结束 PC-01" }));
    await screen.findByRole("button", { name: "确认结束" });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("cancelPreview", {
        previewId: "end-preview",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "结束 PC-01" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认结束" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "end",
        expect.objectContaining({
          recordId: active.id,
          previewId: "end-preview",
        }),
      ),
    );
  });

  it("其他窗口的变更立即刷新；未登录时清空并提示，按钮不可写", async () => {
    render(<StatusWindow />);
    await screen.findByText("PC-01");
    devices = [free];
    act(() => listener?.({ type: "changed" }));
    await waitFor(() => expect(screen.queryByText("PC-01")).toBeNull());
    local = { ...status, authenticated: false, online: false };
    act(() => listener?.({ type: "changed" }));
    await screen.findByText(/请先在管理后台配置连接并登录/);
    expect(screen.getByText("未登录")).toBeTruthy();
    local = { ...status, online: false };
    devices = [device];
    act(() => listener?.({ type: "changed" }));
    const end = await screen.findByRole("button", { name: "结束 PC-01" });
    expect(end.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("连接中断")).toBeTruthy();
  });

  it("标题栏只有最小化和设置，没有关闭或最大化", async () => {
    render(<StatusWindow />);
    await screen.findByText("PC-01");
    fireEvent.click(screen.getByRole("button", { name: "窗口设置" }));
    expect(call).toHaveBeenCalledWith("auxCommand", {
      command: "openSettings",
    });
    expect(screen.getByRole("button", { name: "最小化" })).toBeTruthy();
    expect(
      titlebar().queryByRole("button", { name: /关闭|最大化|全屏/ }),
    ).toBeNull();
  });
});
