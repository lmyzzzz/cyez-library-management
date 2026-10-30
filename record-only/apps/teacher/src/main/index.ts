import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createWindowControlHost } from "@series/electron/main";
import { identityConfigSchema } from "@record/protocol/identity";
import { ApiError } from "@record/protocol";
import { actions, type ActionName } from "../shared/bridge.js";
import { LocalStore } from "./store.js";
import { Coordinator } from "./coordinator.js";
import {
  ProcessReader,
  readerProcessSchema,
  resolveReaderExecutable,
} from "./reader-process.js";
const configSchema = z
  .object({
    environment: z.enum(["development", "integration", "production"]),
    identity: identityConfigSchema,
    readerProcess: readerProcessSchema.optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.environment === "production" && v.readerProcess?.kind !== "external")
      c.addIssue({ code: "custom", message: "EXTERNAL_READER_REQUIRED" });
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
    const file =
      process.env.CYEZ_CLIENT_CONFIG ??
      join(app.getPath("userData"), "client-config.json");
    const config = configSchema.parse(JSON.parse(await readFile(file, "utf8")));
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
      backgroundColor: "#f4f9fc",
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
      config.environment !== "production" &&
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
      config.environment,
      config.identity,
      (event) => {
        if (!window.isDestroyed())
          window.webContents.send("library:event", event);
      },
    );
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
        }
      },
    );
    await coordinator.init();
    if (config.readerProcess) {
      adapter = new ProcessReader(
        resolveReaderExecutable(
          config.readerProcess,
          config.environment,
          app.getAppPath(),
          process.resourcesPath,
          app.isPackaged,
        ),
        config.environment === "production",
      );
      await adapter
        .start(
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
            coordinator!.readerState = "读卡进程已断开，请检查设备后重启应用";
            void coordinator!
              .log({ source: "reader", level: "error", code: "READER_FAILED" })
              .catch(() => {});
            if (!window.isDestroyed())
              window.webContents.send("library:event", { type: "changed" });
          },
          (mock) => {
            coordinator!.readerState = mock
              ? "Rust mock：Wiegand-34 手动输入"
              : "读卡进程已连接";
            if (!window.isDestroyed())
              window.webContents.send("library:event", { type: "changed" });
          },
        )
        .catch(() => {
          coordinator!.readerState = "读卡进程启动失败，请检查配置后重启应用";
        });
    } else coordinator.readerState = "集成环境：测试读卡器";
    interval = setInterval(() => {
      void coordinator!.flush().catch(() => {});
    }, 3000);
    await window.loadURL(renderer);
    window.show();
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
