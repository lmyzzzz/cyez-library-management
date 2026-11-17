import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AddonDTO, DeviceDTO } from "@record/protocol";
import type { LocalStatus } from "../../../apps/teacher/src/shared/bridge.js";
import { AddonSettings } from "../../../apps/teacher/src/renderer/addons.js";
import { ScanModeSwitch } from "../../../apps/teacher/src/renderer/scan-mode.js";
import { DeviceToggle } from "../../../apps/teacher/src/renderer/device-toggle.js";

const call = vi.fn<(action: string, input: unknown) => Promise<unknown>>();
const addon: AddonDTO = {
  id: "end-grade-1-2",
  name: "高一、高二午间结束",
  cron: "40 12 * * *",
  timezone: "Asia/Shanghai",
  enabled: false,
  version: 1,
  lastRun: null,
};
const device: DeviceDTO = {
  id: "00000000-0000-4000-8000-000000000001",
  code: "PC-01",
  displayName: "一号电脑",
  notes: "",
  isDisabled: false,
  deletedAtMs: null,
  version: 4,
  tags: [],
  active: null,
};

beforeEach(() => {
  call.mockReset();
  Object.defineProperty(window, "library", {
    configurable: true,
    value: { call, subscribe: () => () => {} },
  });
});
afterEach(cleanup);

it("登记模式用开关控件切换，成功后立即反映，失败时保留当前模式", async () => {
  const refresh = vi.fn();
  const manual = { scanMode: "manual" } as LocalStatus;
  call.mockResolvedValueOnce({ mode: "automatic" });
  render(<ScanModeSwitch status={manual} refresh={refresh} />);
  const toggle = screen.getByRole<HTMLInputElement>("switch", {
    name: "自动登记模式",
  });
  expect(toggle.checked).toBe(false);
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith("setScanMode", { mode: "automatic" }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(toggle.checked).toBe(true);
  // 失败时开关保持当前模式，不把教师的选择误显示为已生效。
  call.mockRejectedValueOnce(Error("SCAN_MODE_BUSY"));
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(call).toHaveBeenLastCalledWith("setScanMode", { mode: "manual" }),
  );
  await waitFor(() => expect(toggle.checked).toBe(true));
});

it("占用设备不能快捷停用；空闲设备携版本停用并刷新", async () => {
  const refresh = vi.fn();
  const occupied = { ...device, active: { id: "record-1" } } as DeviceDTO;
  const view = render(
    <DeviceToggle device={occupied} disabled={false} refresh={refresh} />,
  );
  const stop = screen.getByRole<HTMLButtonElement>("button", {
    name: "停用 PC-01",
  });
  expect(stop.disabled).toBe(true);
  view.rerender(
    <DeviceToggle device={device} disabled={false} refresh={refresh} />,
  );
  call.mockResolvedValue({ deviceId: device.id, version: 5, isDisabled: true });
  fireEvent.click(screen.getByRole("button", { name: "停用 PC-01" }));
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith("disableDevice", {
      deviceId: device.id,
      expectedVersion: 4,
      isDisabled: true,
    }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
});

it("停用设备用恢复图标按钮，点击后携版本恢复并刷新", async () => {
  const refresh = vi.fn();
  call.mockResolvedValue({ deviceId: device.id });
  render(
    <DeviceToggle
      device={{ ...device, isDisabled: true }}
      disabled={false}
      refresh={refresh}
    />,
  );
  const restore = screen.getByRole("button", { name: "恢复 PC-01" });
  expect(restore.textContent).toBe("");
  fireEvent.click(restore);
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith("disableDevice", {
      deviceId: device.id,
      expectedVersion: 4,
      isDisabled: false,
    }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
});

it("内置加载项从服务器读取状态，开关启用并显式确认手动执行", async () => {
  let state = addon;
  call.mockImplementation(async (action, input) => {
    if (action === "addons") return { items: [state] };
    if (action === "configureAddon") {
      state = { ...state, enabled: true, version: 2 };
      return { id: state.id, enabled: true, version: 2 };
    }
    if (action === "runAddon") return { count: 3 };
    throw new Error(`Unexpected action: ${action} ${String(input)}`);
  });
  render(<AddonSettings authenticated canWrite />);
  expect(await screen.findByText("高一、高二午间结束")).toBeTruthy();
  // 计划时间由 cron 派生，不在渲染层按加载项 ID 硬编码。
  expect(screen.getByText(/每天 12:40（Asia\/Shanghai）/)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /立即执行/ }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("switch", { name: "启用 高一、高二午间结束" }),
  );
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith("configureAddon", {
      addonId: addon.id,
      expectedVersion: 1,
      enabled: true,
    }),
  );
  const run = await screen.findByRole("button", { name: /立即执行/ });
  await waitFor(() => expect(run.hasAttribute("disabled")).toBe(false));
  fireEvent.click(run);
  expect(screen.getByText("立即执行加载项？")).toBeTruthy();
  expect(
    call.mock.calls.filter(([action]) => action === "runAddon"),
  ).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith("runAddon", { addonId: addon.id }),
  );
  expect(await screen.findByText("已结束 3 条使用记录。")).toBeTruthy();
});

it("未登录只显示提示；登录后立即读取并按 10 秒轮询加载项", async () => {
  call.mockResolvedValue({ items: [] });
  vi.useFakeTimers();
  try {
    const view = render(
      <AddonSettings authenticated={false} canWrite={false} />,
    );
    expect(screen.getByText("请先登录服务器。")).toBeTruthy();
    view.rerender(<AddonSettings authenticated canWrite={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(call).toHaveBeenCalledWith("addons", {});
    call.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(call).toHaveBeenCalledWith("addons", {});
  } finally {
    vi.useRealTimers();
  }
});

it("加载项切换失败保留原状态；立即执行失败保留确认弹窗", async () => {
  const state: AddonDTO = { ...addon, enabled: true };
  call.mockImplementation(async (action) => {
    if (action === "addons") return { items: [state] };
    if (action === "configureAddon") throw Error("ADDON_VERSION_CONFLICT");
    if (action === "runAddon") throw Error("ADDON_NOT_READY");
    return {};
  });
  render(<AddonSettings authenticated canWrite />);
  const toggle = await screen.findByRole("switch", {
    name: "禁用 高一、高二午间结束",
  });
  expect((toggle as HTMLInputElement).checked).toBe(true);
  fireEvent.click(toggle);
  expect(await screen.findByText(/加载项状态已变化/)).toBeTruthy();
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLInputElement>("switch", {
        name: "禁用 高一、高二午间结束",
      }).disabled,
    ).toBe(false),
  );
  expect(
    (
      screen.getByRole("switch", {
        name: "禁用 高一、高二午间结束",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "立即执行" }));
  expect(screen.getByText("立即执行加载项？")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
  await waitFor(() => expect(screen.getByText(/加载项尚未就绪/)).toBeTruthy());
  expect(screen.getByText("立即执行加载项？")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() =>
    expect(screen.queryByText("立即执行加载项？")).toBeNull(),
  );
});
