import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

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
export const readerProcessSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mock") }).strict(),
  z
    .object({ kind: z.literal("external"), executable: z.string().min(1) })
    .strict(),
]);
export type ReaderProcessConfig = z.infer<typeof readerProcessSchema>;

export function resolveReaderExecutable(
  config: ReaderProcessConfig,
  environment: string,
  appPath: string,
  resourcesPath: string,
  packaged: boolean,
): string {
  if (config.kind === "mock") {
    if (environment === "production") throw new Error("MOCK_READER_FORBIDDEN");
    return packaged
      ? resolve(resourcesPath, "readers", "cyez-reader-mock.exe")
      : resolve(appPath, "../../target/release/cyez-reader-mock.exe");
  }
  if (
    !isAbsolute(config.executable) ||
    !config.executable.toLowerCase().endsWith(".exe")
  )
    throw new Error("READER_EXECUTABLE_INVALID");
  return config.executable;
}

/** Private inherited pipes only; no renderer/network listener, disk queue or UID logs. */
export class ProcessReader {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stopCurrent: (() => Promise<void>) | undefined;

  constructor(
    private executable: string,
    private production = false,
    private args: string[] = [],
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
          const force = setTimeout(() => child.kill(), 1500);
          const bound = setTimeout(resolveStop, 2500);
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
              if (ready || (this.production && message.kind === "mock"))
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
                accept(uid, mock ? "integration" : "reader");
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
