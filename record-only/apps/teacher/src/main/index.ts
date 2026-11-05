import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { createWindowControlHost } from "@series/electron/main";
import { identityConfigSchema } from "@record/protocol/identity";
import { ApiError } from "@record/protocol";
import { actions, type ActionName } from "../shared/bridge.js";
import type { ReaderProcessConfig } from "../shared/reader-config.js";
import { LocalStore } from "./store.js";
import { Coordinator } from "./coordinator.js";
import {
  ProcessReader,
  readerProcessSchema,
  readerArguments,
  resolveReaderExecutable,
} from "./reader-process.js";
const execFileAsync = promisify(execFile);
const configSchema = z
  .object({
    environment: z.enum(["development", "integration", "production"]),
    identity: identityConfigSchema,
    readerProcess: readerProcessSchema.optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.environment === "production" && v.readerProcess?.kind === "mock")
      c.addIssue({ code: "custom", message: "MOCK_READER_FORBIDDEN" });
    if (
      v.identity.uidByteLengths.length !== 1 ||
      v.identity.uidByteLengths[0] !== 4
    )
      c.addIssue({ code: "custom", message: "WIEGAND34_UID_REQUIRED" });
  });
if (process.env.CYEZ_USER_DATA)
  app.setPath("userData", process.env.CYEZ_USER_DATA);
app.disableHardwareAcceleration();
let coordinator: Coordinator | undefined;
let adapter: ProcessReader | undefined;
let interval: NodeJS.Timeout | undefined;
let stopping = false;
void app.whenReady().then(async () => {
  try {
    const explicitConfig = process.env.CYEZ_CLIENT_CONFIG;
    const file =
      explicitConfig ?? join(app.getPath("userData"), "client-config.json");
    let config: z.infer<typeof configSchema> | null;
    try {
      config = configSchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if (
        explicitConfig !== undefined ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      )
        throw error;
      config = null;
    }
    const environment = config?.environment ?? "production";
    const store = new LocalStore(
      join(app.getPath("userData"), "library.sqlite"),
    );
    await store.init();
    const location = dirname(fileURLToPath(import.meta.url));
    const window = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 760,
      minHeight: 600,
      show: false,
      frame: false,
      backgroundColor: "#fffaf3",
      webPreferences: {
        preload: join(location, "../preload/index.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    const controls = createWindowControlHost();
    controls.bind(window);
    let renderer = pathToFileURL(join(location, "../renderer/index.html")).href;
    if (
      !app.isPackaged &&
      environment !== "production" &&
      process.env.NODE_ENV === "development" &&
      process.env.ELECTRON_RENDERER_URL
    ) {
      const devUrl = new URL(process.env.ELECTRON_RENDERER_URL);
      if (
        devUrl.protocol !== "http:" ||
        devUrl.hostname !== "127.0.0.1" ||
        devUrl.username ||
        devUrl.password ||
        devUrl.pathname !== "/" ||
        devUrl.search ||
        devUrl.hash
      )
        throw new Error("INVALID_DEV_RENDERER_URL");
      renderer = devUrl.href;
    }
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (url.split("#")[0] !== renderer) event.preventDefault();
    });
    window.webContents.session.setPermissionRequestHandler((_wc, _p, cb) =>
      cb(false),
    );
    coordinator = new Coordinator(
      store,
      await store.clientId(),
      environment,
      config?.identity ?? null,
      (event) => {
        if (!window.isDestroyed())
          window.webContents.send("library:event", event);
      },
    );
    let readerConfig: ReaderProcessConfig | undefined = config?.readerProcess;
    let readerChanging = false;
    const savedReader = await store.get("readerProcess");
    let invalidSavedReader = false;
    if (savedReader && config) {
      try {
        const parsed = readerProcessSchema.parse(JSON.parse(savedReader));
        if (environment === "production" && parsed.kind === "mock")
          invalidSavedReader = true;
        else readerConfig = parsed;
      } catch {
        invalidSavedReader = true;
      }
    }
    const startReader = async (choice: ReaderProcessConfig) => {
      let executable: string;
      try {
        executable = resolveReaderExecutable(
          choice,
          environment,
          app.getAppPath(),
          process.resourcesPath,
          app.isPackaged,
        );
      } catch {
        throw new ApiError("READER_EXECUTABLE_INVALID", 422);
      }
      const candidate = new ProcessReader(
        executable,
        environment === "production",
        readerArguments(choice),
      );
      adapter = candidate;
      try {
        await candidate.start(
          (uid, source) => {
            void coordinator!.reader.accept(uid, source).catch(() =>
              coordinator!.log({
                source: "reader",
                level: "error",
                code: "READER_FAILED",
              }),
            );
          },
          () => {
            if (adapter !== candidate) return;
            coordinator!.readerState = "读卡进程已断开，请检查设备或重新配置";
            void coordinator!
              .log({ source: "reader", level: "error", code: "READER_FAILED" })
              .catch(() => {});
            if (!window.isDestroyed())
              window.webContents.send("library:event", { type: "changed" });
          },
          (mock) => {
            if (adapter !== candidate) return;
            coordinator!.readerState = mock
              ? "Rust mock：Wiegand-34 手动输入"
              : choice.kind === "serial"
                ? "串口读卡进程已连接"
                : choice.kind === "acr1552"
                  ? "ACR1552U-M1 读卡进程已连接"
                  : "读卡进程已连接";
            if (!window.isDestroyed())
              window.webContents.send("library:event", { type: "changed" });
          },
        );
        return candidate;
      } catch {
        if (adapter === candidate) adapter = undefined;
        await candidate.stop();
        throw new ApiError("READER_PROCESS_UNAVAILABLE", 503);
      }
    };
    const replaceReader = async (choice: ReaderProcessConfig) => {
      if (readerChanging) throw new ApiError("READER_CHANGE_BUSY", 409);
      if (environment === "production" && choice.kind === "mock")
        throw new ApiError("MOCK_READER_FORBIDDEN", 403);
      readerChanging = true;
      try {
        const previous = readerConfig;
        await adapter?.stop();
        adapter = undefined;
        let candidate: ProcessReader | undefined;
        try {
          candidate = await startReader(choice);
          await store.set("readerProcess", JSON.stringify(choice));
          readerConfig = choice;
        } catch (error) {
          coordinator!.readerState = "读卡进程配置失败";
          await candidate?.stop();
          adapter = undefined;
          if (previous) await startReader(previous).catch(() => {});
          throw error;
        }
      } finally {
        readerChanging = false;
      }
    };
    const listSerialPorts = async () => {
      try {
        const executable = resolveReaderExecutable(
          {
            kind: "serial",
            port: "COM1",
            baudRate: 9600,
            dataBits: 8,
            parity: "none",
            stopBits: 1,
            flowControl: "none",
            format: "hex8",
          },
          environment,
          app.getAppPath(),
          process.resourcesPath,
          app.isPackaged,
        );
        const env: NodeJS.ProcessEnv = {};
        for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH"])
          if (process.env[key]) env[key] = process.env[key];
        const { stdout } = await execFileAsync(executable, ["--list-ports"], {
          timeout: 5000,
          maxBuffer: 8192,
          windowsHide: true,
          env,
        });
        return z
          .object({ ports: z.array(z.string().min(1).max(128)).max(128) })
          .strict()
          .parse(JSON.parse(stdout));
      } catch {
        throw new ApiError("READER_PORT_LIST_FAILED", 503);
      }
    };
    const listAcr1552Readers = async () => {
      try {
        const executable = resolveReaderExecutable(
          { kind: "acr1552", reader: "ACR1552", pollMs: 250 },
          environment,
          app.getAppPath(),
          process.resourcesPath,
          app.isPackaged,
        );
        const env: NodeJS.ProcessEnv = {};
        for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH"])
          if (process.env[key]) env[key] = process.env[key];
        const { stdout } = await execFileAsync(executable, ["--list-readers"], {
          timeout: 5000,
          maxBuffer: 8192,
          windowsHide: true,
          env,
        });
        return z
          .object({
            readers: z.array(z.string().min(1).max(128)).max(128),
          })
          .strict()
          .parse(JSON.parse(stdout));
      } catch {
        throw new ApiError("READER_PCSC_LIST_FAILED", 503);
      }
    };
    ipcMain.handle(
      "library:action",
      async (event, action: unknown, input: unknown) => {
        if (
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url.split("#")[0] !== renderer ||
          typeof action !== "string" ||
          !Object.hasOwn(actions, action)
        )
          return { ok: false, code: "IPC_FORBIDDEN", status: 403 };
        try {
          if (action === "initializeClient") {
            if (config) throw new ApiError("IDENTITY_ALREADY_CONFIGURED", 409);
            const parsed = configSchema.safeParse({
              environment: "production",
              identity: input,
            });
            if (!parsed.success) throw new ApiError("INPUT_INVALID", 422);
            try {
              await writeFile(file, JSON.stringify(parsed.data) + "\n", {
                flag: "wx",
                mode: 0o600,
              });
            } catch (error) {
              throw new ApiError(
                (error as NodeJS.ErrnoException).code === "EEXIST"
                  ? "CLIENT_CONFIG_EXISTS"
                  : "CLIENT_CONFIG_SAVE_FAILED",
                503,
              );
            }
            config = parsed.data;
            coordinator!.reader.configure(parsed.data.identity);
            coordinator!.readerState = "未配置读卡进程";
            if (!window.isDestroyed())
              window.webContents.send("library:event", { type: "changed" });
            return { ok: true, value: { ok: true } };
          }
          if (
            !config &&
            action !== "status" &&
            action !== "gate" &&
            action !== "uiError"
          )
            throw new ApiError("IDENTITY_CONFIG_REQUIRED", 409);
          if (action === "listSerialPorts") {
            if (!actions.listSerialPorts.safeParse(input).success)
              throw new ApiError("INPUT_INVALID", 422);
            return { ok: true, value: await listSerialPorts() };
          }
          if (action === "listAcr1552Readers") {
            if (!actions.listAcr1552Readers.safeParse(input).success)
              throw new ApiError("INPUT_INVALID", 422);
            return { ok: true, value: await listAcr1552Readers() };
          }
          if (action === "configureReader") {
            const parsed = readerProcessSchema.safeParse(input);
            if (!parsed.success) throw new ApiError("INPUT_INVALID", 422);
            const choice = parsed.data;
            await replaceReader(choice);
            return { ok: true, value: { ok: true } };
          }
          return {
            ok: true,
            value: await coordinator!.call(action as ActionName, input),
          };
        } catch (e) {
          return {
            ok: false,
            code: e instanceof ApiError ? e.code : "LOCAL_OPERATION_FAILED",
            status: e instanceof ApiError ? e.status : 503,
          };
        } finally {
          if (
            action === "replaceProviderConfig" &&
            input &&
            typeof input === "object"
          )
            for (const key of Object.keys(input))
              (input as Record<string, unknown>)[key] = undefined;
        }
      },
    );
    await coordinator.init();
    if (readerConfig) {
      await startReader(readerConfig).catch(() => {
        coordinator!.readerState = "读卡进程启动失败，请检查配置";
      });
    } else
      coordinator.readerState = !config
        ? "等待首次配置"
        : invalidSavedReader
          ? "原读卡配置无效，请重新选择"
          : "未配置读卡进程";
    interval = setInterval(() => {
      void coordinator!.flush().catch(() => {});
    }, 3000);
    await window.loadURL(renderer);
    window.show();
    if (config) void coordinator.autoLoginOnStartup().catch(() => {});
    window.on("closed", () => app.quit());
  } catch {
    dialog.showErrorBox(
      "启动失败",
      "请提供有效的 client-config.json，并检查本地存储和读卡进程。生产环境需配置真实读卡可执行文件。",
    );
    app.quit();
  }
});
app.on("before-quit", (event) => {
  if (stopping) return;
  event.preventDefault();
  stopping = true;
  clearInterval(interval);
  void (async () => {
    await adapter?.stop();
    await coordinator?.close();
    app.quit();
  })().catch(() => app.exit(1));
});
