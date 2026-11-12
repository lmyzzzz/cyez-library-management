import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { ReaderProcessConfig } from "../shared/reader-config.js";
export { readerProcessSchema } from "../shared/reader-config.js";

const messageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("ready"),
      protocol: z.literal(1),
      kind: z.enum(["mock", "hardware"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("scan"),
      uidHex: z.string().regex(/^[0-9a-f]{8}$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      code: z.enum(["READER_IO", "INVALID_FRAME"]),
    })
    .strict(),
]);
export function resolveReaderExecutable(
  config: ReaderProcessConfig,
  _environment: string,
  appPath: string,
  resourcesPath: string,
  packaged: boolean,
): string {
  if (config.kind === "mock") {
    return packaged
      ? resolve(resourcesPath, "readers", "cyez-reader-mock.exe")
      : resolve(appPath, "../../target/release/cyez-reader-mock.exe");
  }
  if (config.kind === "serial")
    return packaged
      ? resolve(resourcesPath, "readers", "cyez-reader-serial.exe")
      : resolve(appPath, "../../target/release/cyez-reader-serial.exe");
  if (config.kind === "acr1552")
    return packaged
      ? resolve(resourcesPath, "readers", "cyez-reader-acr1552.exe")
      : resolve(appPath, "../../target/release/cyez-reader-acr1552.exe");
  if (
    !isAbsolute(config.executable) ||
    !config.executable.toLowerCase().endsWith(".exe")
  )
    throw new Error("READER_EXECUTABLE_INVALID");
  return config.executable;
}

export function readerArguments(config: ReaderProcessConfig): string[] {
  if (config.kind === "acr1552")
    return [
      "--reader",
      config.reader,
      "--poll-ms",
      String(config.pollMs),
      "--uid-byte-order",
      config.uidByteOrder,
      "--protocol",
      config.protocol,
      "--access-mode",
      config.accessMode,
    ];
  return config.kind === "serial"
    ? [
        "--port",
        config.port,
        "--baud",
        String(config.baudRate),
        "--data-bits",
        String(config.dataBits),
        "--parity",
        config.parity,
        "--stop-bits",
        String(config.stopBits),
        "--flow-control",
        config.flowControl,
        "--format",
        config.format,
      ]
    : [];
}

/** Private inherited pipes only; no renderer/network listener, disk queue or UID logs. */
export class ProcessReader {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stopCurrent: (() => Promise<void>) | undefined;

  constructor(
    private executable: string,
    private production = false,
    private args: string[] = [],
    private expectedKind?: "mock" | "hardware",
  ) {}

  async start(
    accept: (uid: Uint8Array, source: "reader" | "integration") => void,
    onError: () => void,
    onReady: (mock: boolean) => void = () => {},
  ): Promise<void> {
    if (this.child) throw new Error("READER_ALREADY_STARTED");
    // Do not inherit teacher/provider credentials, NODE_OPTIONS or arbitrary configuration.
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "SystemRoot",
      "WINDIR",
      "TEMP",
      "TMP",
      "PATH",
      "USERPROFILE",
      "LOCALAPPDATA",
    ])
      if (process.env[key]) env[key] = process.env[key];
    const child = spawn(this.executable, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env,
    });
    this.child = child;
    let pending = Buffer.alloc(0);
    let ready = false;
    let mock = false;
    let failed = false;
    let settled = false;
    let stopping = false;
    let stopPromise: Promise<void> | undefined;
    child.stderr.resume(); // Raw third-party diagnostics are never copied to application logs.
    return new Promise<void>((resolveStart, rejectStart) => {
      const deadline = setTimeout(() => fail(), 5000);
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (ok) resolveStart();
        else rejectStart(new Error("READER_PROCESS_UNAVAILABLE"));
      };
      const fail = () => {
        if (failed || stopping) return;
        failed = true;
        pending.fill(0);
        pending = Buffer.alloc(0);
        settle(false);
        try {
          onError();
        } finally {
          child.kill();
        }
      };
      this.stopCurrent = () => {
        if (stopPromise) return stopPromise;
        stopping = true;
        pending.fill(0);
        settle(false);
        stopPromise = new Promise<void>((resolveStop) => {
          // A valid ACR poll interval can be up to 2s; allow it to finish gracefully.
          const force = setTimeout(() => child.kill(), 2500);
          const bound = setTimeout(resolveStop, 3500);
          child.once("close", () => {
            clearTimeout(force);
            clearTimeout(bound);
            resolveStop();
          });
          child.stdin.end('{"type":"shutdown"}\n');
        });
        return stopPromise;
      };
      child.stdin.on("error", fail);
      child.stdout.on("error", fail);
      child.on("error", fail);
      child.once("close", () => {
        if (!stopping) fail();
        pending.fill(0);
        if (this.child === child) {
          this.child = undefined;
          this.stopCurrent = undefined;
        }
        settle(false);
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (stopping || failed) {
          chunk.fill(0);
          return;
        }
        let data: Buffer | undefined;
        try {
          // Limit incomplete lines; pipe chunk boundaries need not equal message boundaries.
          data = Buffer.concat([pending, chunk]);
          pending.fill(0);
          let start = 0;
          for (let i = 0; i < data.length; i++) {
            if (data[i] !== 10) {
              if (i - start >= 256) throw new Error("READER_FRAME_TOO_LARGE");
              continue;
            }
            const message = messageSchema.parse(
              JSON.parse(data.toString("utf8", start, i)),
            );
            start = i + 1;
            if (message.type === "ready") {
              if (
                ready ||
                (this.expectedKind && message.kind !== this.expectedKind) ||
                (this.production &&
                  message.kind === "mock" &&
                  this.expectedKind !== "mock")
              )
                throw new Error("READER_HANDSHAKE_INVALID");
              ready = true;
              mock = message.kind === "mock";
              onReady(mock);
              settle(true);
            } else if (!ready) throw new Error("READER_NOT_READY");
            else if (message.type === "scan") {
              const uid = Buffer.from(message.uidHex, "hex");
              message.uidHex = "";
              try {
                accept(
                  uid,
                  mock && !this.production ? "integration" : "reader",
                );
              } finally {
                uid.fill(0);
              }
            } else throw new Error("READER_REPORTED_ERROR");
          }
          pending = Buffer.from(data.subarray(start));
        } catch {
          fail();
        } finally {
          data?.fill(0);
          chunk.fill(0);
        }
      });
    });
  }

  async stop(): Promise<void> {
    await this.stopCurrent?.();
  }
}
