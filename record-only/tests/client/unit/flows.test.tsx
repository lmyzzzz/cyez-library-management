import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
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
import { IdleTimer } from "../../../apps/teacher/src/renderer/timers.js";

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
  it("释放弹窗与过期登记不能被二次刷卡绕过", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const onCancel = vi.fn();
    call.mockImplementation(async (action) => {
      if (action === "devices")
        return {
          devices: {
            items: [free, { ...free, id: "occupied", code: "PC-02", active }],
            total: 2,
            page: 1,
            pageSize: 20,
          },
        };
      if (action === "endPreview")
        return {
          ...preview,
          id: "release-preview",
          mode: "end",
          record: active,
        };
      return {};
    });
    const form = (confirmSignal: number) => (
      <Registration
        preview={preview}
        confirmSignal={confirmSignal}
        onDone={vi.fn()}
        onCancel={onCancel}
        onBusy={vi.fn()}
      />
    );
    try {
      const view = render(form(0));
      await screen.findByRole("button", { name: "取消选择 PC-01" });
      fireEvent.click(screen.getByRole("button", { name: /^释放 / }));
      await screen.findByText("释放这台设备？");
      view.rerender(form(1));
      expect(
        call.mock.calls.filter(
          ([action]) => action === "start" || action === "end",
        ),
      ).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      now = 10001;
      view.rerender(form(2));
      expect(onCancel).toHaveBeenCalledOnce();
      expect(
        call.mock.calls.filter(([action]) => action === "start"),
      ).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["start", "end"])(
    "%s 二次刷卡离线不提交，重连不重放，连续确认只提交一次",
    async (mode) => {
      let finish!: () => void;
      call.mockImplementation(async (action) => {
        if (action === "devices")
          return {
            devices: { items: [free], total: 1, page: 1, pageSize: 20 },
          };
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
      const onDone = vi.fn();
      const form = (online: boolean, confirmSignal: number) =>
        mode === "start" ? (
          <Registration
            preview={preview}
            online={online}
            confirmSignal={confirmSignal}
            onDone={onDone}
            onCancel={vi.fn()}
            onBusy={vi.fn()}
          />
        ) : (
          <EndForm
            preview={{ ...preview, mode: "end", record: active }}
            automatic
            online={online}
            confirmSignal={confirmSignal}
            onDone={onDone}
            onCancel={vi.fn()}
            onBusy={vi.fn()}
          />
        );
      const view = render(form(true, 0));
      if (mode === "start")
        await screen.findByRole("button", { name: "取消选择 PC-01" });
      view.rerender(form(false, 1));
      expect(
        call.mock.calls.filter(([action]) => action === mode),
      ).toHaveLength(0);
      view.rerender(form(true, 1));
      expect(
        call.mock.calls.filter(([action]) => action === mode),
      ).toHaveLength(0);
      view.rerender(form(true, 2));
      view.rerender(form(true, 3));
      expect(
        call.mock.calls.filter(([action]) => action === mode),
      ).toHaveLength(1);
      finish();
      await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    },
  );

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
    // 刷卡进入登记后自动选中第一台可用设备。
    expect(
      await screen.findByRole("button", { name: "取消选择 PC-01" }),
    ).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /^选择 / })).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "确认登记" }).hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.change(screen.getByLabelText("登记备注"), {
      target: { value: "需要设备" },
    });
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

  it("登记提交失败后解除锁定并重新计时，可再次提交", async () => {
    let attempts = 0;
    call.mockImplementation(async (action) => {
      if (action === "devices")
        return {
          devices: {
            items: [free],
            total: 1,
            page: 1,
            pageSize: 20,
          },
        };
      if (action === "start") {
        attempts += 1;
        if (attempts === 1) throw Error("DEVICE_UNAVAILABLE");
      }
      return {};
    });
    const onDone = vi.fn();
    render(
      <Registration
        preview={preview}
        onDone={onDone}
        onCancel={vi.fn()}
        onBusy={vi.fn()}
      />,
    );
    const confirm = await screen.findByRole("button", { name: "确认登记" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(screen.getByText(/设备已被占用、禁用或删除/)).toBeTruthy(),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "确认登记" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认登记" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(attempts).toBe(2);
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
    fireEvent.click(await screen.findByRole("button", { name: /^释放 / }));
    await waitFor(() =>
      expect(screen.getByText("释放这台设备？")).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认释放" }));
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

  it.each(["start", "end"])(
    "%s 流程 10 秒无操作取消：失焦不暂停，无焦点的输入不算操作",
    async (mode) => {
      let now = 0;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
      const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      // jsdom 无法产生 isTrusted 事件；这里把到达计时器的输入都视为真实输入，
      // 以单独验证“无焦点不算操作”的门控。
      const activity = IdleTimer.prototype.activity;
      const trusted = vi
        .spyOn(IdleTimer.prototype, "activity")
        .mockImplementation(function (this: IdleTimer) {
          activity.call(this, true);
        });
      const onCancel = vi.fn();
      call.mockImplementation(async (action) =>
        action === "devices"
          ? { devices: { items: [free], total: 1, page: 1, pageSize: 20 } }
          : {},
      );
      vi.useFakeTimers();
      try {
        render(
          mode === "start" ? (
            <Registration
              preview={preview}
              onDone={vi.fn()}
              onCancel={onCancel}
              onBusy={vi.fn()}
            />
          ) : (
            <EndForm
              preview={{ ...preview, mode: "end", record: active }}
              automatic
              onDone={vi.fn()}
              onCancel={onCancel}
              onBusy={vi.fn()}
            />
          ),
        );
        const advance = async (ms: number) => {
          now += ms;
          await act(async () => {
            await vi.advanceTimersByTimeAsync(ms);
          });
        };
        await advance(0);
        const click = () =>
          act(() => {
            document.body.dispatchEvent(
              new MouseEvent("click", { bubbles: true }),
            );
          });
        expect(screen.getByText(/请再次刷卡确认/)).toBeTruthy();
        // 有焦点时的真实操作重新计时。
        await advance(6000);
        click();
        await advance(6000);
        expect(onCancel).not.toHaveBeenCalled();
        // 失焦不暂停计时，无焦点时的输入也不算操作。
        fireEvent(window, new Event("blur"));
        focus.mockReturnValue(false);
        await advance(3000);
        click();
        await advance(900);
        expect(onCancel).not.toHaveBeenCalled();
        await advance(200);
        expect(onCancel).toHaveBeenCalledOnce();
        // 到期只取消，从不自动提交。
        expect(
          call.mock.calls.filter(
            ([action]) => action === "start" || action === "end",
          ),
        ).toHaveLength(0);
      } finally {
        vi.useRealTimers();
        cleanup();
        clock.mockRestore();
        focus.mockRestore();
        trusted.mockRestore();
      }
    },
  );

  it("刷卡结束过期后二次刷卡不提交；编辑备注不暂停计时", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const end = { ...preview, mode: "end" as const, record: active };
    const onCancel = vi.fn();
    const form = (confirmSignal: number) => (
      <EndForm
        preview={end}
        automatic
        confirmSignal={confirmSignal}
        onDone={vi.fn()}
        onCancel={onCancel}
        onBusy={vi.fn()}
      />
    );
    try {
      const view = render(form(0));
      fireEvent.change(screen.getByLabelText("使用备注"), {
        target: { value: "修改" },
      });
      expect(screen.queryByRole("button", { name: "继续倒计时" })).toBeNull();
      expect(screen.getByText(/秒无操作将自动取消/)).toBeTruthy();
      now = 10001;
      view.rerender(form(1));
      expect(onCancel).toHaveBeenCalledOnce();
      expect(call).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("默认选中第一台可用设备并跳转到它所在的分页和位置", async () => {
    const all: DeviceDTO[] = Array.from({ length: 45 }, (_, i) => ({
      ...free,
      id: `device-${i}`,
      code: `PC-${String(i + 1).padStart(2, "0")}`,
      // 前 30 台使用中，随后 2 台禁用，第 33 台才是第一台可用设备。
      active: i < 30 ? active : null,
      isDisabled: i >= 30 && i < 32,
    }));
    call.mockImplementation(async (action, input) => {
      if (action !== "devices") return {};
      const { page, pageSize } = input as { page: number; pageSize: number };
      return {
        devices: {
          items: all.slice((page - 1) * pageSize, page * pageSize),
          total: all.length,
          page,
          pageSize,
        },
      };
    });
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      const onDone = vi.fn();
      render(
        <Registration
          preview={preview}
          onDone={onDone}
          onCancel={vi.fn()}
          onBusy={vi.fn()}
        />,
      );
      const chosen = await screen.findByRole("button", {
        name: "取消选择 PC-33",
      });
      // 每页 20 台：第 33 台在第 2 页，列表直接显示这一页。
      expect(call).toHaveBeenCalledWith(
        "devices",
        expect.objectContaining({ page: 2, pageSize: 20 }),
      );
      expect(
        call.mock.calls.filter(
          ([action, input]) =>
            action === "devices" &&
            (input as { pageSize: number }).pageSize === 20 &&
            (input as { page: number }).page === 1,
        ),
      ).toHaveLength(0);
      expect(screen.getByText("2 / 3")).toBeTruthy();
      await waitFor(() => expect(scroll).toHaveBeenCalledOnce());
      expect(scroll.mock.contexts[0]).toBe(chosen.closest(".bflow-row"));
      expect(screen.getByText("请再次刷卡确认登记")).toBeTruthy();
      expect(screen.getByText(/将登记使用 PC-33/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "确认登记" }));
      await waitFor(() =>
        expect(onDone).toHaveBeenCalledWith(
          expect.objectContaining({ code: "PC-33" }),
        ),
      );
      expect(call).toHaveBeenCalledWith(
        "start",
        expect.objectContaining({ deviceId: "device-32" }),
      );
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("没有可用设备时提示联系教师，不能确认", async () => {
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
    await screen.findByText("当前没有可用设备");
    expect(
      screen.getByRole("button", { name: "确认登记" }).hasAttribute("disabled"),
    ).toBe(true);
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

  it("再次刷同一张卡等同点击确认登记", async () => {
    call.mockImplementation(async (action) =>
      action === "devices"
        ? {
            devices: { items: [free], total: 1, page: 1, pageSize: 20 },
          }
        : {},
    );
    const onDone = vi.fn();
    const view = render(
      <Registration
        preview={preview}
        confirmSignal={0}
        onDone={onDone}
        onCancel={vi.fn()}
        onBusy={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: "取消选择 PC-01" });
    view.rerender(
      <Registration
        preview={preview}
        confirmSignal={1}
        onDone={onDone}
        onCancel={vi.fn()}
        onBusy={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("start", {
        previewId: preview.id,
        deviceId: free.id,
        notes: "",
      }),
    );
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("再次刷同一张卡立即确认结束", async () => {
    const end = { ...preview, mode: "end" as const, record: active };
    const onDone = vi.fn();
    const view = render(
      <EndForm
        preview={end}
        automatic
        confirmSignal={0}
        onDone={onDone}
        onCancel={vi.fn()}
        onBusy={vi.fn()}
      />,
    );
    view.rerender(
      <EndForm
        preview={end}
        automatic
        confirmSignal={1}
        onDone={onDone}
        onCancel={vi.fn()}
        onBusy={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("end", {
        recordId: active.id,
        expectedVersion: active.version,
        previewId: preview.id,
        notes: active.notes,
      }),
    );
    expect(onDone).toHaveBeenCalledOnce();
  });
});
