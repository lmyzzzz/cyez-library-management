import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { DeviceDTO, ScanPreview } from "@record/protocol";
import type {
  TeacherEvent,
  LocalStatus,
} from "../../../apps/teacher/src/shared/bridge.js";
import { App } from "../../../apps/teacher/src/renderer/App.js";

if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver)
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
for (const name of [
  "hasPointerCapture",
  "setPointerCapture",
  "releasePointerCapture",
] as const)
  if (!(Element.prototype as unknown as Record<string, unknown>)[name])
    (Element.prototype as unknown as Record<string, unknown>)[name] = () =>
      false;

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
  notes: "设备备注",
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
const call = vi.fn<(action: string, input: unknown) => Promise<unknown>>();
let listener: ((event: TeacherEvent) => void) | undefined;
let local = { ...status };
let devices = [device, free];
beforeEach(() => {
  call.mockReset();
  listener = undefined;
  local = { ...status };
  devices = [device, free];
  call.mockImplementation(async (action, input) => {
    if (action === "status") return local;
    if (action === "devices")
      return {
        devices: {
          items: devices,
          total: devices.length,
          page: 1,
          pageSize: 30,
        },
        status: {
          mode: "normal",
          allowedActions: ["read", "scan", "start", "end", "modify"],
        },
      };
    if (action === "tags")
      return { items: [{ id: "tag-1", name: "阅览区", version: 1 }] };
    if (action === "endPreview")
      return {
        id: "end-preview",
        mode: "end",
        atMs: Date.now(),
        expiresAtMs: Date.now() + 10000,
        record: active,
      };
    if (action === "batchPreview")
      return {
        scope: (input as { scope: string }).scope,
        total: 1,
        units: [
          {
            id: "batch-1",
            atMs: Date.now(),
            expiresAtMs: Date.now() + 10000,
            records: [active],
          },
        ],
      };
    if (action === "history")
      return { items: [], total: 0, page: 1, pageSize: 30 };
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
  Object.defineProperty(window, "windowControls", {
    configurable: true,
    value: {
      minimize: async () => {},
      toggleMaximize: async () => {},
      close: async () => {},
      getMaximized: async () => false,
      onMaximizedChange: () => () => {},
    },
  });
});
afterEach(cleanup);
function show(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}
async function openDeviceMenu(index: number) {
  fireEvent.keyDown(
    screen.getAllByRole("button", { name: "设备操作" })[index],
    { key: "Enter" },
  );
  await screen.findByRole("menuitem", { name: "编辑" });
}

async function openBatchMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: "批量结束" }), {
    key: "Enter",
  });
  await screen.findByRole("menuitem", { name: /结束选中/ });
}

describe("C-U-01/05 主页面门控和状态", () => {
  it("自动更新只修改数据，保留勾选、滚动和弹窗草稿及焦点", async () => {
    vi.useFakeTimers();
    try {
      let view!: ReturnType<typeof show>;
      await act(async () => {
        view = show();
      });
      const scroll =
        view.container.querySelector<HTMLElement>(".table-scroll")!;
      const row = screen.getByText(device.displayName).closest("tr");
      fireEvent.click(screen.getByLabelText("选择 PC-01"));
      scroll.scrollTop = 120;
      scroll.scrollLeft = 40;
      fireEvent.click(screen.getByRole("button", { name: "备注" }));
      const notes = screen.getByLabelText<HTMLTextAreaElement>("当前使用备注");
      fireEvent.change(notes, { target: { value: "正在输入的草稿" } });
      notes.focus();
      notes.setSelectionRange(2, 5);
      notes.style.height = "240px";
      devices = [{ ...device, displayName: "另一位教师更新的名称" }, free];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6500);
      });
      expect(screen.getByText("另一位教师更新的名称").closest("tr")).toBe(row);
      expect(view.container.querySelector(".table-scroll")).toBe(scroll);
      expect(scroll.scrollTop).toBe(120);
      expect(scroll.scrollLeft).toBe(40);
      expect(
        screen.getByLabelText<HTMLInputElement>("选择 PC-01").checked,
      ).toBe(true);
      expect(screen.getByLabelText("当前使用备注")).toBe(notes);
      expect(notes.value).toBe("正在输入的草稿");
      expect(notes.style.height).toBe("240px");
      expect(notes.selectionStart).toBe(2);
      expect(notes.selectionEnd).toBe(5);
      expect(document.activeElement).toBe(notes);
      expect(
        call.mock.calls.filter(([action]) => action === "devices").length,
      ).toBeGreaterThanOrEqual(3);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("连接状态更新不重新挂载正在编辑的连接表单", async () => {
    show("/settings");
    await waitFor(() =>
      expect(screen.getByLabelText("服务器 IP")).toBeTruthy(),
    );
    const ip = screen.getByLabelText<HTMLInputElement>("服务器 IP");
    const pin =
      screen.getByLabelText<HTMLTextAreaElement>("叶证书 SHA-256 指纹");
    fireEvent.change(ip, { target: { value: "192.168.1.20" } });
    pin.style.height = "240px";
    local = {
      ...local,
      connectionConfigured: false,
    };
    await act(async () => {
      listener!({ type: "changed" });
    });
    expect(screen.getByLabelText("服务器 IP")).toBe(ip);
    expect(ip.value).toBe("192.168.1.20");
    expect(screen.getByLabelText("叶证书 SHA-256 指纹")).toBe(pin);
    expect(pin.style.height).toBe("240px");
  });

  it("后台轮询保持空态与表格节点，不进入手动刷新的加载状态", async () => {
    devices = [];
    const view = show();
    await waitFor(() =>
      expect(screen.getByText(/当前筛选没有设备/)).toBeTruthy(),
    );
    const table = view.container.querySelector(".table-scroll")!;
    const refresh = screen.getByRole("button", { name: "刷新" });
    let finish!: (value: unknown) => void;
    const original = call.getMockImplementation()!;
    call.mockImplementation((action, input) =>
      action === "devices"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(action, input),
    );
    vi.useFakeTimers();
    try {
      // Visibility recovery uses the same passive update as the scheduled poll.
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(finish).toBeTypeOf("function");
      expect(view.container.querySelector(".table-scroll")).toBe(table);
      expect(table.getAttribute("aria-busy")).toBe("false");
      expect(refresh.hasAttribute("disabled")).toBe(false);
      expect(screen.getByText(/当前筛选没有设备/)).toBeTruthy();
      expect(view.container.querySelector(".skeleton")).toBeNull();
      await act(async () => {
        finish({
          devices: { items: [free], total: 1, page: 1, pageSize: 30 },
          status: { mode: "normal", allowedActions: ["read"] },
        });
      });
      expect(screen.getByText(free.displayName)).toBeTruthy();
      expect(view.container.querySelector(".table-scroll")).toBe(table);
    } finally {
      vi.useRealTimers();
    }
  });

  it("活动列表、筛选、备注、结束预览和批量确认入口", async () => {
    show();
    await waitFor(() => expect(screen.getByText("活动备注")).toBeTruthy());
    expect(call).toHaveBeenCalledWith("gate", {
      page: "devices",
      modal: false,
      submitting: false,
    });
    fireEvent.change(screen.getByLabelText("搜索设备"), {
      target: { value: "PC-01" },
    });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "devices",
        expect.objectContaining({ search: "PC-01" }),
      ),
    );
    fireEvent.change(screen.getByLabelText("设备标签"), {
      target: { value: "tag-1" },
    });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "devices",
        expect.objectContaining({ tagId: "tag-1" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "备注" }));
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
    fireEvent.click(screen.getByRole("button", { name: "结束…" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("endPreview", { recordId: active.id }),
    );
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await openBatchMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "结束全部…" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("batchPreview", { scope: "all" }),
    );
    expect(screen.getByText(/后来新增的记录不会加入本次操作/)).toBeTruthy();
  });

  it("设置管理设备、删除确认、历史与诊断入口", async () => {
    show("/settings");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "设备管理" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "设备管理" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "新增设备" })).toBeTruthy(),
    );
    await openDeviceMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑" }));
    expect(screen.getByText("编辑设备")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await openDeviceMenu(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "删除…" }));
    expect(screen.getByText("删除设备确认")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "确认删除" }).hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "历史记录" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "history",
        expect.objectContaining({ state: "ended" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "诊断" }));
    expect(screen.getByText("本机诊断")).toBeTruthy();
  });

  it("未认证、断线、存储失败与待确认提交显示限制", async () => {
    local = {
      ...status,
      authenticated: false,
      online: false,
      storage: "failed",
      pendingCommands: 1,
    };
    show();
    await waitFor(() =>
      expect(screen.getByText(/请先在设置中配置连接并登录/)).toBeTruthy(),
    );
    await openBatchMenu();
    expect(
      screen
        .getByRole("menuitem", { name: "结束全部…" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByText(/有 1 条提交结果待确认/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查询原提交" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("recover", {}));
  });

  it("未连接时刷卡拒绝以页面错误横幅显示，不依赖短暂 toast", async () => {
    local = { ...status, authenticated: false, online: false };
    show();
    await waitFor(() => expect(listener).toBeTypeOf("function"));
    await act(async () => {
      listener!({ type: "notice", code: "OFFLINE_NO_WRITE" });
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "连接已中断，禁止新业务写入。请恢复连接。",
    );
    fireEvent.click(screen.getByRole("alert").querySelector("button")!);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("刷卡事件只在主页面打开登记，取消释放 preview", async () => {
    show();
    await waitFor(() => expect(listener).toBeTypeOf("function"));
    await act(async () => {
      listener!({ type: "notice", code: "SCAN_RETURN_TO_DEVICES" });
    });
    expect(screen.getByRole("alert").textContent).toContain("请返回主页面");
    await act(async () => {
      listener!({ type: "scan", preview });
    });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "选择设备" })).toBeTruthy(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消登记" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("cancelPreview", {
        previewId: preview.id,
      }),
    );
  });

  it("选中/取消选中、状态切换与两种批量范围使用当前筛选", async () => {
    show();
    await waitFor(() =>
      expect(screen.getByLabelText("选择 PC-01")).toBeTruthy(),
    );
    fireEvent.click(screen.getByLabelText("选择 PC-01"));
    await openBatchMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "结束选中 (1)" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("batchPreview", {
        scope: "selected",
        recordIds: [active.id],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByLabelText("选择 PC-01"));
    await openBatchMenu();
    expect(
      screen
        .getByRole("menuitem", { name: "结束选中 (0)" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.change(screen.getByLabelText("搜索设备"), {
      target: { value: "PC" },
    });
    await openBatchMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "结束筛选结果…" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "batchPreview",
        expect.objectContaining({
          scope: "filtered",
          filter: expect.objectContaining({ deviceSearch: "PC" }),
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "未使用" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "刷新" }).hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "devices",
        expect.objectContaining({ state: "free" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "使用中" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  });

  it("设置中新增、管理标签、删除空闲设备和诊断刷新", async () => {
    show("/settings");
    fireEvent.click(screen.getByRole("button", { name: "设备管理" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "新增设备" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "新增设备" }));
    expect(screen.getByRole("heading", { name: "新增设备" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "管理标签" }));
    expect(screen.getByRole("heading", { name: "管理标签" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭对话框" }));
    await openDeviceMenu(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "删除…" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("deleteDevice", {
        deviceId: free.id,
        expectedVersion: free.version,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "诊断" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新诊断" }));
    await waitFor(() =>
      expect(
        call.mock.calls.filter(([action]) => action === "status").length,
      ).toBeGreaterThan(1),
    );
  });

  it("使用中设备禁止删除；刷卡结束全屏隐藏导航，取消后恢复", async () => {
    show("/settings");
    fireEvent.click(screen.getByRole("button", { name: "设备管理" }));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "设备操作" })).toHaveLength(
        2,
      ),
    );
    await openDeviceMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "删除…" }));
    expect(
      screen.getByRole("button", { name: "确认删除" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("link", { name: "使用登记" }));
    await waitFor(() => expect(listener).toBeTypeOf("function"));
    listener!({
      type: "scan",
      preview: { ...preview, mode: "end", record: active },
    });
    await waitFor(() => expect(screen.getByText("刷卡结束使用")).toBeTruthy());
    expect(screen.queryByRole("link", { name: "设置" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "设置" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("link", { name: "设置" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("cancelPreview", {
        previewId: preview.id,
      }),
    );
  });

  it("自动刷新失败不会停掉轮询，恢复后继续更新数据", async () => {
    vi.useFakeTimers();
    try {
      let failures = 2;
      const original = call.getMockImplementation()!;
      call.mockImplementation((action, input) => {
        if (action === "status") {
          if (failures > 0) {
            failures -= 1;
            return Promise.reject(Error("NETWORK_TIMEOUT"));
          }
          return Promise.resolve({ ...local });
        }
        return original(action, input);
      });
      await act(async () => {
        show();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6500);
      });
      expect(
        call.mock.calls.filter(([action]) => action === "devices").length,
      ).toBeGreaterThan(0);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("认证失效后清除旧设备、标签与进行中的刷卡流程", async () => {
    show();
    await waitFor(() => expect(screen.getByText("活动备注")).toBeTruthy());
    await act(async () => {
      listener!({ type: "scan", preview });
    });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "选择设备" })).toBeTruthy(),
    );
    local = { ...local, authenticated: false, online: false };
    await act(async () => {
      listener!({ type: "changed" });
    });
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "选择设备" })).toBeNull(),
    );
    expect(screen.queryByText("活动备注")).toBeNull();
    expect(screen.getByText(/请先在设置中配置连接并登录/)).toBeTruthy();
  });

  it("取消手动结束与批量结束弹窗会撤销服务器预览", async () => {
    show();
    await waitFor(() => expect(screen.getByText("活动备注")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "结束…" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("endPreview", { recordId: active.id }),
    );
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("cancelPreview", {
        previewId: "end-preview",
      }),
    );
    await openBatchMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "结束全部…" }));
    await waitFor(() =>
      expect(screen.getByText(/后来新增的记录不会加入本次操作/)).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("cancelPreview", {
        previewId: "batch-1",
      }),
    );
  });

  it("设置设备管理按全部、使用中和未使用筛选", async () => {
    show("/settings");
    fireEvent.click(screen.getByRole("button", { name: "设备管理" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "devices",
        expect.objectContaining({ state: "all" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "使用中" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "devices",
        expect.objectContaining({ state: "active" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "未使用" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "devices",
        expect.objectContaining({ state: "free" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() =>
      expect(
        call.mock.calls.filter(
          ([action, input]) =>
            action === "devices" &&
            (input as { state?: string }).state === "all",
        ).length,
      ).toBeGreaterThan(1),
    );
  });

  it("集成环境测试读卡器三个入口传递明确 fixture", async () => {
    show();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "测试卡 1" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "测试卡 1" }));
    fireEvent.click(screen.getByRole("button", { name: "测试卡 2" }));
    fireEvent.click(screen.getByRole("button", { name: "未授权测试卡" }));
    for (const fixture of ["allowed-1", "allowed-2", "unknown"])
      expect(call).toHaveBeenCalledWith("integrationScan", { fixture });
  });
});
