import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { DeviceDTO, ScanPreview, BatchPreview } from "@record/protocol";
import {
  EndForm,
  Registration,
  BatchForm,
} from "../../../apps/teacher/src/renderer/flows.js";

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
  notes: "旧备注",
  endReason: null,
  version: 1,
};
const preview: ScanPreview = {
  id: "preview-1",
  mode: "start",
  student,
  record: null,
  atMs: Date.now(),
  expiresAtMs: Date.now() + 10000,
};
const free: DeviceDTO = {
  id: "device-1",
  code: "PC-01",
  displayName: "一号电脑",
  notes: "",
  isDisabled: false,
  deletedAtMs: null,
  version: 1,
  tags: [],
  active: null,
};

describe("C-U 登记、结束与批量确认", () => {
  it("登记选择可用设备并提交，禁用和占用设备不能直接分配", async () => {
    call.mockImplementation(async (action) =>
      action === "devices"
        ? {
            devices: {
              items: [
                free,
                { ...free, id: "disabled", isDisabled: true },
                { ...free, id: "occupied", active },
              ],
              total: 3,
              page: 1,
              pageSize: 20,
            },
          }
        : {},
    );
    const onDone = vi.fn(),
      onBusy = vi.fn();
    render(
      <Registration
        preview={preview}
        onDone={onDone}
        onCancel={vi.fn()}
        onBusy={onBusy}
      />,
    );
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "选择" })).toHaveLength(2),
    );
    expect(
      screen.getByRole("button", { name: "确认登记" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("登记备注"), {
      target: { value: "需要设备" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "选择" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "确认登记" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("start", {
        previewId: preview.id,
        deviceId: free.id,
        notes: "需要设备",
      }),
    );
    expect(onDone).toHaveBeenCalledOnce();
    expect(onBusy).toHaveBeenCalledWith(true);
  });

  it("活动设备先结束后必须重新刷卡，不能复用旧时间登记", async () => {
    call.mockImplementation(async (action) =>
      action === "devices"
        ? {
            devices: {
              items: [{ ...free, active }],
              total: 1,
              page: 1,
              pageSize: 20,
            },
          }
        : action === "endPreview"
          ? {
              id: "end-preview",
              mode: "end",
              atMs: Date.now(),
              expiresAtMs: Date.now() + 10000,
              record: active,
            }
          : {},
    );
    render(
      <Registration
        preview={preview}
        onDone={vi.fn()}
        onCancel={vi.fn()}
        onBusy={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "先结束使用…" }));
    await waitFor(() =>
      expect(screen.getByText("先结束当前使用")).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认结束" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "end",
        expect.objectContaining({ recordId: active.id }),
      ),
    );
    expect(
      screen.getByRole("button", { name: "确认登记" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(call.mock.calls.some(([action]) => action === "start")).toBe(false);
  });

  it("手动结束失败显示冲突，重试仍保留原版本和预览键", async () => {
    const end = { ...preview, mode: "end" as const, record: active };
    const onDone = vi.fn();
    call.mockRejectedValueOnce(Error("RECORD_VERSION_CONFLICT"));
    render(
      <EndForm
        preview={end}
        automatic={false}
        onDone={onDone}
        onCancel={vi.fn()}
        onBusy={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("使用备注"), {
      target: { value: "结束备注" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认结束" }));
    await waitFor(() => expect(screen.getByText(/记录已变化/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "确认结束" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(call).toHaveBeenLastCalledWith("end", {
      recordId: active.id,
      expectedVersion: 1,
      previewId: preview.id,
      notes: "结束备注",
    });
  });

  it("自动结束编辑或失焦暂停，必须显式继续或确认", async () => {
    const end = { ...preview, mode: "end" as const, record: active };
    render(
      <EndForm
        preview={end}
        automatic
        onDone={vi.fn()}
        onCancel={vi.fn()}
        onBusy={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("使用备注"), {
      target: { value: "修改" },
    });
    expect(screen.getByText(/自动确认已暂停/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "继续倒计时" }));
    fireEvent(window, new Event("blur"));
    expect(screen.getByText(/自动确认已暂停/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it("批量逐批提交、第二批失败保留第一批状态且不重复", async () => {
    const batch: BatchPreview = {
      scope: "selected",
      total: 2,
      units: [
        {
          id: "batch-1",
          atMs: Date.now(),
          expiresAtMs: Date.now() + 10000,
          records: [active],
        },
        {
          id: "batch-2",
          atMs: Date.now(),
          expiresAtMs: Date.now() + 10000,
          records: [{ ...active, id: "record-2" }],
        },
      ],
    };
    call.mockImplementation(async (_action, input) => {
      if ((input as { previewId?: string }).previewId === "batch-2")
        throw Error("RECORD_VERSION_CONFLICT");
      return {};
    });
    const onDone = vi.fn();
    render(
      <BatchForm
        preview={batch}
        onDone={onDone}
        onCancel={vi.fn()}
        onBusy={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("追加公共备注"), {
      target: { value: "闭馆" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认结束 2 条" }));
    await waitFor(() => expect(screen.getByText(/记录已变化/)).toBeTruthy());
    expect(call).toHaveBeenNthCalledWith(1, "batchConfirm", {
      previewId: "batch-1",
      notes: "闭馆",
    });
    expect(call).toHaveBeenNthCalledWith(2, "batchConfirm", {
      previewId: "batch-2",
      notes: "闭馆",
    });
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByText(/失败后保留已完成批次/)).toBeTruthy();
  });
});
