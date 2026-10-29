import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
  connection: { ip: "127.0.0.1", port: 8443, pin: "ab".repeat(32) },
  authenticated: true,
  online: true,
  savedCredentials: false,
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

describe("C-U-01/05 主页面门控和状态", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "结束全部…" }));
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
    fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]);
    expect(screen.getByText("编辑设备")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getAllByRole("button", { name: "删除…" })[1]);
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
    expect(
      screen
        .getByRole("button", { name: "结束全部…" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText(/有 1 条提交结果待确认/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查询原提交" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("recover", {}));
  });

  it("刷卡事件只在主页面打开登记，取消释放 preview", async () => {
    show();
    await waitFor(() => expect(listener).toBeTypeOf("function"));
    listener!({ type: "scan", preview });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "登记使用" })).toBeTruthy(),
    );
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
    fireEvent.click(screen.getByRole("button", { name: "结束选中 (1)" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("batchPreview", {
        scope: "selected",
        recordIds: [active.id],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByLabelText("选择 PC-01"));
    expect(
      screen
        .getByRole("button", { name: "结束选中 (0)" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("搜索设备"), {
      target: { value: "PC" },
    });
    fireEvent.click(screen.getByRole("button", { name: "结束筛选结果…" }));
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
    fireEvent.click(screen.getAllByRole("button", { name: "删除…" })[1]);
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

  it("使用中设备禁止删除；刷卡结束流转和设置切换释放预览", async () => {
    show("/settings");
    fireEvent.click(screen.getByRole("button", { name: "设备管理" }));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "删除…" })).toHaveLength(2),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "删除…" })[0]);
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
    fireEvent.click(screen.getByRole("link", { name: "设置" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("cancelPreview", {
        previewId: preview.id,
      }),
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
