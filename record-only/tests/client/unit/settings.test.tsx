import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { DeviceDTO, RecordDTO, TagDTO } from "@record/protocol";
import type { LocalStatus } from "../../../apps/teacher/src/shared/bridge.js";
import {
  ConnectionForm,
  DeviceEditor,
  TagManager,
  History,
} from "../../../apps/teacher/src/renderer/settings.js";

const call = vi.fn<(action: string, input: unknown) => Promise<unknown>>();
beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue({});
  Object.defineProperty(window, "library", {
    configurable: true,
    value: { call },
  });
});
afterEach(cleanup);

const status = {
  connection: { ip: "127.0.0.1", port: 8443, pin: "ab".repeat(32) },
  authenticated: false,
  online: false,
  savedCredentials: true,
  pendingLogs: 0,
  pendingCommands: 0,
  pendingOtherOrigins: 0,
  oldestLogAgeMs: 0,
  storage: "normal",
  reader: "测试读卡器",
  environment: "integration",
  version: "0.1.0",
  lastSuccessMs: null,
} satisfies LocalStatus;
const tag: TagDTO = { id: "tag-1", name: "阅览区", version: 1 };
const device: DeviceDTO = {
  id: "device-1",
  code: "PC-01",
  displayName: "一号电脑",
  notes: "原备注",
  isDisabled: false,
  deletedAtMs: null,
  version: 3,
  tags: [tag],
  active: null,
};
const record: RecordDTO = {
  id: "record-1",
  student: {
    id: "a".repeat(64),
    name: "测试学生",
    className: "一班",
    schoolNumber: "T001",
    version: 1,
    refreshedAtMs: Date.now(),
  },
  device: { id: device.id, code: device.code, displayName: device.displayName },
  startedAtMs: Date.now() - 60000,
  endedAtMs: Date.now(),
  notes: "只读备注",
  endReason: "manual",
  version: 2,
};

describe("C-U-05 设置和只读历史", () => {
  it("连接测试、登录、保存密码清除和失败反馈", async () => {
    const refresh = vi.fn();
    render(<ConnectionForm status={status} refresh={refresh} />);
    fireEvent.change(screen.getByLabelText("服务器 IP"), {
      target: { value: "127.0.0.2" },
    });
    fireEvent.change(screen.getByLabelText("HTTPS 端口"), {
      target: { value: "9443" },
    });
    fireEvent.change(screen.getByLabelText("叶证书 SHA-256 指纹"), {
      target: { value: "cd".repeat(32) },
    });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("testConnection", {}),
    );
    expect(call).toHaveBeenCalledWith("configure", {
      ip: "127.0.0.2",
      port: 9443,
      pin: "cd".repeat(32),
    });
    expect(screen.getByText("连接及证书校验通过")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("共享账号"), {
      target: { value: "teacher" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByLabelText("记住登录信息"));
    fireEvent.click(screen.getByRole("button", { name: "保存并登录" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("login", {
        username: "teacher",
        password: "secret",
        remember: true,
      }),
    );
    expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "使用已保存登录" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("loginSaved", {}));
    fireEvent.click(screen.getByRole("button", { name: "清除保存项" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("clearSaved", {}));
    call.mockRejectedValueOnce(Error("PIN_INVALID"));
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() => expect(screen.getByText(/64 位 SHA-256/)).toBeTruthy());
    expect(refresh).toHaveBeenCalled();
  });

  it("设备创建、编辑、标签选择和失败状态", async () => {
    const onDone = vi.fn(),
      onBusy = vi.fn();
    const view = render(
      <DeviceEditor
        device={null}
        tags={[tag]}
        onDone={onDone}
        onCancel={vi.fn()}
        onBusy={onBusy}
      />,
    );
    fireEvent.change(screen.getByLabelText("设备编号"), {
      target: { value: "PC-02" },
    });
    fireEvent.change(screen.getByLabelText("设备名称"), {
      target: { value: "二号电脑" },
    });
    fireEvent.click(screen.getByLabelText("阅览区"));
    fireEvent.click(screen.getByRole("button", { name: "保存设备" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "createDevice",
        expect.objectContaining({
          code: "PC-02",
          displayName: "二号电脑",
          tagIds: [tag.id],
        }),
      ),
    );
    expect(onDone).toHaveBeenCalledOnce();
    expect(onBusy).toHaveBeenCalledWith(true);
    view.unmount();
    call.mockRejectedValueOnce(Error("DEVICE_VERSION_CONFLICT"));
    render(
      <DeviceEditor
        device={device}
        tags={[tag]}
        onDone={onDone}
        onCancel={vi.fn()}
        onBusy={onBusy}
      />,
    );
    fireEvent.click(screen.getByLabelText("禁用新登记（不会结束现有使用）"));
    fireEvent.click(screen.getByRole("button", { name: "保存设备" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "editDevice",
        expect.objectContaining({
          deviceId: device.id,
          expectedVersion: 3,
          isDisabled: true,
        }),
      ),
    );
    expect(screen.getByText(/设备已被其他客户端修改/)).toBeTruthy();
  });

  it("标签增删改和删除确认", async () => {
    const refresh = vi.fn();
    render(<TagManager tags={[tag]} refresh={refresh} onBusy={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("标签名称"), {
      target: { value: "新区域" },
    });
    fireEvent.click(screen.getByRole("button", { name: "新增标签" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("createTag", { name: "新区域" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("标签名称"), {
      target: { value: "修改区域" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存标签" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("editTag", {
        tagId: tag.id,
        expectedVersion: tag.version,
        name: "修改区域",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "删除…" }));
    expect(screen.getByText(/将移除其设备关联/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认删除标签" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("deleteTag", {
        tagId: tag.id,
        expectedVersion: tag.version,
      }),
    );
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("历史按筛选查询、键盘打开详情，不提供写入命令", async () => {
    call.mockResolvedValue({
      items: [record],
      total: 1,
      page: 1,
      pageSize: 30,
    });
    render(<History authenticated tagOptions={[tag]} onModal={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("只读备注")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("搜索学生"), {
      target: { value: "测试" },
    });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "history",
        expect.objectContaining({ search: "测试", state: "ended" }),
      ),
    );
    fireEvent.change(screen.getByLabelText("历史标签"), {
      target: { value: tag.id },
    });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "history",
        expect.objectContaining({ tagId: tag.id }),
      ),
    );
    fireEvent.keyDown(screen.getByText("只读备注").closest("tr")!, {
      key: "Enter",
    });
    await waitFor(() => expect(screen.getByText("历史记录详情")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "保存备注" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: "重置筛选" }));
    expect(call.mock.calls.every(([action]) => action === "history")).toBe(
      true,
    );
  });
});
