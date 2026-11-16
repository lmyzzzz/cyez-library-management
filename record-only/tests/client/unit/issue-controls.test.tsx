import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AddonDTO, DeviceDTO } from "@record/protocol";
import type { LocalStatus } from "../../../apps/teacher/src/shared/bridge.js";
import { AddonSettings } from "../../../apps/teacher/src/renderer/addons.js";
import {
  DeviceToggle,
  ScanModeControl,
} from "../../../apps/teacher/src/renderer/device-controls.js";

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
    value: { call },
  });
});
afterEach(cleanup);

it("模式切换将明确选择交给 main，失败时保留当前模式", async () => {
  const refresh = vi.fn();
  const status = { scanMode: "manual" } as LocalStatus;
  call.mockResolvedValueOnce({ mode: "automatic" });
  render(<ScanModeControl status={status} refresh={refresh} />);
  fireEvent.change(screen.getByLabelText("登记模式"), {
    target: { value: "automatic" },
  });
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith("setScanMode", { mode: "automatic" }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(screen.getByLabelText<HTMLSelectElement>("登记模式").value).toBe(
    "manual",
  );
});

it("占用设备不能快捷停用；空闲设备携版本停用并刷新", async () => {
  const refresh = vi.fn();
  const occupied = { ...device, active: { id: "record-1" } } as DeviceDTO;
  const view = render(
    <DeviceToggle device={occupied} disabled={false} refresh={refresh} />,
  );
  expect(
    screen.getByRole("button", { name: "停用 PC-01" }).hasAttribute("disabled"),
  ).toBe(true);
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

it("内置加载项只能从服务器读取状态，启用后需显式确认手动执行", async () => {
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
  expect(
    screen.getByRole("button", { name: /立即执行/ }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /启用 高一/ }));
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith("configureAddon", {
      addonId: addon.id,
      expectedVersion: 1,
      enabled: true,
    }),
  );
  const run = await screen.findByRole("button", { name: /立即执行 高一/ });
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
