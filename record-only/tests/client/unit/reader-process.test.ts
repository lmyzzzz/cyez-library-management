import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import {
  ProcessReader,
  readerProcessSchema,
  resolveReaderExecutable,
} from "../../../apps/teacher/src/main/reader-process.js";

const executable = resolve("target/release/cyez-reader-mock.exe");

describe("Wiegand-34 独立读卡进程", () => {
  it("配置只允许集成 mock 或绝对路径生产进程", () => {
    expect(readerProcessSchema.safeParse({ kind: "mock" }).success).toBe(true);
    expect(
      readerProcessSchema.safeParse({ kind: "external", executable }).success,
    ).toBe(true);
    expect(() =>
      resolveReaderExecutable(
        { kind: "mock" },
        "production",
        "C:/app",
        "C:/resources",
        true,
      ),
    ).toThrow("MOCK_READER_FORBIDDEN");
    expect(() =>
      resolveReaderExecutable(
        { kind: "external", executable: "reader.exe" },
        "production",
        "C:/app",
        "C:/resources",
        true,
      ),
    ).toThrow("READER_EXECUTABLE_INVALID");
    expect(
      resolveReaderExecutable(
        { kind: "mock" },
        "integration",
        "C:/app",
        "C:/resources",
        true,
      ),
    ).toMatch(/readers[\\/]cyez-reader-mock\.exe$/);
  });

  it("实际 Rust 子进程输出握手与无损 4 字节 UID", async () => {
    const reader = new ProcessReader(executable, false, [
      "--test-uid",
      "00000001",
    ]);
    const scans: string[] = [];
    const error = vi.fn();
    await reader.start((uid, source) => {
      scans.push(`${Buffer.from(uid).toString("hex")}:${source}`);
    }, error);
    await vi.waitFor(() => expect(scans).toEqual(["00000001:integration"]));
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1)); // One-shot test process exits.
    await reader.stop();
  });

  it("生产进程拒绝 mock 握手，且未就绪不能发送 UID", async () => {
    const reader = new ProcessReader(executable, true, [
      "--test-uid",
      "00000001",
    ]);
    const accept = vi.fn();
    const error = vi.fn();
    await expect(reader.start(accept, error)).rejects.toThrow(
      "READER_PROCESS_UNAVAILABLE",
    );
    expect(accept).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    await reader.stop();
  });

  it("畸形帧和缺少 ready 的消息不得变成刷卡", async () => {
    for (const line of [
      '{"type":"scan","uidHex":"00000001"}',
      '{"type":"ready","protocol":1,"kind":"hardware"}\n{"type":"scan","uidHex":"000000001"}',
      '{"type":"ready","protocol":2,"kind":"hardware"}',
      '{"type":"ready","protocol":1,"kind":"hardware"}\n{"type":"ready","protocol":1,"kind":"hardware"}',
      '{"type":"ready","protocol":1,"kind":"hardware"}\n{"type":"error","code":"INVALID_FRAME"}\n{"type":"scan","uidHex":"00000001"}',
      '{"type":"error","code":"arbitrary diagnostic text"}',
      "x".repeat(257),
      "{}",
    ]) {
      const reader = new ProcessReader(process.execPath, false, [
        "-e",
        `process.stdout.write(${JSON.stringify(line + "\n")})`,
      ]);
      const accept = vi.fn();
      const error = vi.fn();
      try {
        await reader.start(accept, error);
        await vi.waitFor(() => expect(error).toHaveBeenCalled());
      } catch {
        expect(error).toHaveBeenCalled();
      }
      expect(accept).not.toHaveBeenCalled();
      await reader.stop();
    }
  });

  it("分片、多行和 CRLF 只在完整帧交付，交付后覆写 buffer", async () => {
    const reader = new ProcessReader(process.execPath, false, [
      "-e",
      `
      process.stdout.write('{"type":"ready","protocol":1,"kind":"hardware"}\\r\\n{"type":"sc');
      setTimeout(() => process.stdout.write('an","uidHex":"00abcdef"}\\n{"type":"scan","uidHex":"ffffffff"}\\n'), 50);
      process.stdin.resume(); process.stdin.on('end', () => process.exit(0));
    `,
    ]);
    const error = vi.fn();
    const received: Uint8Array[] = [];
    const values: string[] = [];
    await reader.start((uid, source) => {
      expect(source).toBe("reader");
      received.push(uid);
      values.push(Buffer.from(uid).toString("hex"));
    }, error);
    try {
      await vi.waitFor(() => expect(values).toEqual(["00abcdef", "ffffffff"]));
      expect(received.every((uid) => uid.every((b) => b === 0))).toBe(true);
      await expect(reader.start(vi.fn(), error)).rejects.toThrow(
        "READER_ALREADY_STARTED",
      );
    } finally {
      await Promise.all([reader.stop(), reader.stop()]);
    }
    expect(error).not.toHaveBeenCalled();
  });

  it("真实 Rust GUI 进程响应 shutdown，结束后可重新启动", async () => {
    const reader = new ProcessReader(executable);
    const error = vi.fn();
    const ready = vi.fn();
    for (let i = 0; i < 2; i++) {
      await reader.start(vi.fn(), error, ready);
      await reader.stop();
    }
    expect(ready.mock.calls).toEqual([[true], [true]]);
    expect(error).not.toHaveBeenCalled();
  });

  it("丢失可执行文件、握手超时和提前退出均有界失败", async () => {
    for (const reader of [
      new ProcessReader(resolve("target/missing-reader.exe")),
      new ProcessReader(process.execPath, false, ["-e", "process.exit(0)"]),
      new ProcessReader(process.execPath, false, [
        "-e",
        "setInterval(() => {}, 1000)",
      ]),
    ]) {
      const error = vi.fn();
      await expect(reader.start(vi.fn(), error)).rejects.toThrow(
        "READER_PROCESS_UNAVAILABLE",
      );
      await reader.stop();
      expect(error).toHaveBeenCalledTimes(1);
    }
  }, 10000);

  it("握手前取消不会挂起；忽略 shutdown 的进程会强制退出", async () => {
    const reader = new ProcessReader(process.execPath, false, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    const error = vi.fn();
    const started = expect(reader.start(vi.fn(), error)).rejects.toThrow(
      "READER_PROCESS_UNAVAILABLE",
    );
    await reader.stop();
    await started;
    await reader.stop();
    expect(error).not.toHaveBeenCalled();
  });
});
