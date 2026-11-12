import { app, ipcMain, dialog, Menu } from "electron";
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
import { AppWindows } from "./windows.js";
import { roleAllows } from "../shared/windows.js";
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
    if (!__CYEZ_TEST_FEATURES__ && v.environment !== "production")
      c.addIssue({ code: "custom", message: "PRODUCTION_CONFIG_REQUIRED" });
    if (
      v.identity.uidByteLengths.length !== 1 ||
      v.identity.uidByteLengths[0] !== 4
    )
      c.addIssue({ code: "custom", message: "WIEGAND34_UID_REQUIRED" });
  });
if (process.env.CYEZ_USER_DATA)
  app.setPath("userData", process.env.CYEZ_USER_DATA);
app.disableHardwareAcceleration();
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else app.on("second-instance", () => windows?.raise("main"));
let coordinator: Coordinator | undefined;
let adapter: ProcessReader | undefined;
let interval: NodeJS.Timeout | undefined;
let stopping = false;
let windows: AppWindows | undefined;
void app.whenReady().then(async () => {
  if (!primaryInstance) return;
  try {
    if (!__CYEZ_TEST_FEATURES__) Menu.setApplicationMenu(null);
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
    let renderer = pathToFileURL(join(location, "../renderer/index.html")).href;
    if (
      __CYEZ_TEST_FEATURES__ &&
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
    const appWindows = new AppWindows({
      preload: join(location, "../preload/index.cjs"),
      renderer,
      devTools: __CYEZ_TEST_FEATURES__,
      settings: store,
      quitting: () => stopping,
      onScanClosed: () => void coordinator?.releaseScan().catch(() => {}),
    });
    windows = appWindows;
    await appWindows.init();
    const window = appWindows.create("main");
    const controls = createWindowControlHost();
    controls.bind(window);
    window.webContents.session.setPermissionRequestHandler((_wc, _p, cb) =>
      cb(false),
    );
    coordinator = new Coordinator(
      store,
      await store.clientId(),
      environment,
      config?.identity ?? null,
      (event, origin) => {
        if (origin !== "card") {
          // 状态变化通知全部窗口；登录、存储等提示只属于管理后台。
          if (event.type === "changed") appWindows.broadcast(event);
          else appWindows.send("main", event);
          return;
        }
        // 刷卡只由刷卡窗口处理；窗口被关闭时在管理后台提示。
        if (appWindows.get("scan")) {
          appWindows.cardReceived();
          appWindows.send("scan", event);
        } else
          appWindows.send("main", {
            type: "notice",
            code: "SCAN_WINDOW_CLOSED",
          });
      },
      app.getVersion(),
    );
    let readerConfig: ReaderProcessConfig | undefined = config?.readerProcess;
    let readerChanging = false;
    const savedReader = await store.get("readerProcess");
    let invalidSavedReader = false;
    if (savedReader && config) {
      try {
        const parsed = readerProcessSchema.parse(JSON.parse(savedReader));
        readerConfig = parsed;
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
        choice.kind === "mock" ? "mock" : "hardware",
      );
      adapter = candidate;
      try {
        await candidate.start(
          (uid, source) => {
            void coordinator!.reader.accept(uid, source).catch(() =>
              coordinator!
                .log({
                  source: "reader",
                  level: "error",
                  code: "READER_FAILED",
                })
                .catch(() => {}),
            );
          },
          () => {
            if (adapter !== candidate) return;
            coordinator!.readerState = "读卡进程已断开，请检查设备或重新配置";
            void coordinator!
              .log({ source: "reader", level: "error", code: "READER_FAILED" })
              .catch(() => {});
            appWindows.broadcast({ type: "changed" });
          },
          (mock) => {
            if (adapter !== candidate) return;
            coordinator!.readerState = mock
              ? "手动输入已就绪"
              : choice.kind === "serial"
                ? "串口读卡进程已连接"
                : choice.kind === "acr1552"
                  ? "ACR1552U-M1 读卡进程已连接"
                  : "读卡进程已连接";
            appWindows.broadcast({ type: "changed" });
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
          {
            kind: "acr1552",
            reader: "ACR1552",
            pollMs: 250,
            uidByteOrder: "forward",
            protocol: "auto",
            accessMode: "shared",
          },
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
        const role = appWindows.roleOf(event.sender);
        if (
          !role ||
          event.senderFrame !== event.sender.mainFrame ||
          event.senderFrame.url.split("#")[0] !== appWindows.url(role) ||
          typeof action !== "string" ||
          !Object.hasOwn(actions, action) ||
          !roleAllows(role, action)
        )
          return { ok: false, code: "IPC_FORBIDDEN", status: 403 };
        try {
          if (
            action === "windowState" ||
            action === "setAuxWindow" ||
            action === "setScanAutoFocus" ||
            action === "setScanFullscreen" ||
            action === "moveScanDisplay" ||
            action === "auxCommand"
          ) {
            const parsed = actions[action].safeParse(input);
            if (!parsed.success) throw new ApiError("INPUT_INVALID", 422);
            const data = parsed.data as {
              window?: "scan" | "status";
              open?: boolean;
              enabled?: boolean;
              command?: "minimize" | "toggleFullscreen" | "openSettings";
            };
            if (action === "setAuxWindow") {
              if (data.open) await appWindows.open(data.window!);
              else await appWindows.close(data.window!);
            } else if (action === "setScanAutoFocus")
              await appWindows.setAutoFocus(data.enabled!);
            else if (action === "setScanFullscreen")
              appWindows.get("scan")?.setFullScreen(data.enabled!);
            else if (action === "moveScanDisplay")
              await appWindows.moveScanToNextDisplay();
            else if (action === "auxCommand") {
              if (data.command === "minimize") appWindows.minimize(role);
              else if (data.command === "openSettings")
                appWindows.openSettings();
              else if (role === "scan") appWindows.toggleFullscreen();
            }
            return { ok: true, value: appWindows.state() };
          }
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
            appWindows.broadcast({ type: "changed" });
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
    window.on("closed", () => app.quit());
    await window.loadURL(renderer);
    window.show();
    if (config) void coordinator.autoLoginOnStartup().catch(() => {});
    // 无论上次是否关闭，每次启动都重新打开刷卡窗口和状态悬浮窗。
    await appWindows.open("scan");
    await appWindows.open("status");
  } catch {
    dialog.showErrorBox(
      "启动失败",
      "请提供有效的 client-config.json，并检查本地存储和读卡进程。",
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
    await windows?.flush();
    await adapter?.stop();
    await coordinator?.close();
    app.quit();
  })().catch(() => app.exit(1));
});
