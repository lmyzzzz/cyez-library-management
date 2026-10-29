// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  IdleTimer,
  EndTimer,
} from "../../../apps/teacher/src/renderer/timers.js";
import { CardReader } from "../../../apps/teacher/src/main/reader.js";
import { ClientSDK } from "@record/client-sdk";
import { ApiError } from "@record/protocol";
import { identity } from "../../helpers/config.js";
import {
  connectionOrigin,
  verifyCertificate,
} from "../../../apps/teacher/src/main/pin.js";
describe("C-U 计时和读卡边界", () => {
  it("10 秒连续空闲，9.9 秒真实输入重置，合成事件不重置", () => {
    let now = 0,
      cancel = 0;
    const idle = new IdleTimer(
      () => now,
      () => cancel++,
    );
    now = 9900;
    idle.activity(true);
    now = 10000;
    expect(idle.check()).toBe(false);
    expect(idle.remaining()).toBe(9900);
    idle.activity(false);
    now = 19900;
    expect(idle.check()).toBe(true);
    expect(cancel).toBe(1);
    idle.check();
    idle.activity(true);
    expect(cancel).toBe(1);
    expect(idle.submit()).toBe(false);
  });
  it("后台/唤醒先检查期限，提交后不执行空闲取消", () => {
    let now = 0,
      cancel = 0;
    const idle = new IdleTimer(
      () => now,
      () => cancel++,
    );
    now = 20000;
    idle.activity(true);
    expect(cancel).toBe(1);
    const submitted = new IdleTimer(
      () => now,
      () => cancel++,
    );
    expect(submitted.submit()).toBe(true);
    now = 40000;
    submitted.check();
    expect(cancel).toBe(1);
    const stopped = new IdleTimer(
      () => now,
      () => cancel++,
    );
    stopped.stop();
    expect(stopped.check()).toBe(true);
  });
  it("结束 5 秒确认、编辑/失焦暂停、显式恢复与单次门闩", () => {
    let now = 0,
      sent = 0;
    const timer = new EndTimer(
      () => now,
      () => sent++,
    );
    now = 4999;
    timer.tick();
    expect(sent).toBe(0);
    expect(timer.remaining()).toBe(1);
    timer.pause();
    now = 10000;
    timer.tick();
    expect(timer.remaining()).toBeNull();
    expect(sent).toBe(0);
    timer.resume();
    now = 15000;
    timer.tick();
    timer.submit();
    timer.resume();
    timer.tick();
    expect(sent).toBe(1);
    const stopped = new EndTimer(
      () => now,
      () => sent++,
    );
    stopped.stop();
    now += 6000;
    stopped.tick();
    expect(sent).toBe(1);
  });
  it("reader 立即 hash，覆盖可写 buffer，重复帧合并，完成释放卡输入", async () => {
    let now = 0;
    const events: { id: string; uid: string }[] = [];
    let transient: unknown;
    const reader = new CardReader(
      identity,
      async (event) => {
        transient = event.card;
        events.push({ id: event.studentId, uid: event.card.uidHex });
      },
      () => now,
    );
    const buffer = Buffer.from("00000001", "hex");
    await reader.accept(buffer);
    expect([...buffer]).toEqual([0, 0, 0, 0]);
    expect(events[0].id).toMatch(/^[a-f0-9]{64}$/);
    expect(events[0].uid).toBe("00000001");
    expect(transient).toEqual({ issuer: "", uidHex: "" });
    await reader.accept(Buffer.from("00000001", "hex"));
    expect(events).toHaveLength(1);
    now = 1200;
    await reader.accept(Buffer.from("00000001", "hex"));
    expect(events).toHaveLength(2);
  });
  it("固定 IP origin，默认 443 规范化，拒绝 URL/无效 pin", () => {
    expect(
      connectionOrigin({ ip: "127.0.0.1", port: 443, pin: "ab".repeat(32) }),
    ).toBe("https://127.0.0.1");
    expect(
      connectionOrigin({ ip: "::1", port: 8443, pin: "ab".repeat(32) }),
    ).toBe("https://[::1]:8443");
    expect(() =>
      connectionOrigin({ ip: "https://evil", port: 443, pin: "ab".repeat(32) }),
    ).toThrow();
    expect(
      verifyCertificate("invalid", "127.0.0.1", {
        ip: "127.0.0.1",
        port: 443,
        pin: "ab".repeat(32),
      }),
    ).toBe(false);
  });
  it("SDK 不向 renderer 返回 token，401 清会话，关闭传输", async () => {
    let fail = false,
      closed = false;
    const transport = {
      request: async () => {
        if (fail) throw new ApiError("AUTH_REQUIRED", 401);
        return { token: "test-token" };
      },
      close: async () => {
        closed = true;
      },
    };
    const sdk = new ClientSDK(transport, "test-client");
    await expect(sdk.call("GET", "/api/v1/devices")).rejects.toThrow(
      "AUTH_REQUIRED",
    );
    expect(await sdk.login("teacher", "password")).toBeUndefined();
    expect(sdk.authenticated).toBe(true);
    fail = true;
    await expect(sdk.call("GET", "/api/v1/devices")).rejects.toThrow();
    expect(sdk.authenticated).toBe(false);
    fail = false;
    await sdk.login("t", "p");
    await sdk.logout();
    expect(sdk.authenticated).toBe(false);
    await sdk.close();
    expect(closed).toBe(true);
  });
});
