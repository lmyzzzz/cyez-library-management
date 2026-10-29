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
import type { ReaderAdapter } from "./reader.js";
const configSchema = z
  .object({
    environment: z.enum(["development", "integration", "production"]),
    identity: identityConfigSchema,
    readerModule: z.string().optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.environment === "production" && !v.readerModule)
      c.addIssue({ code: "custom", message: "READER_ADAPTER_REQUIRED" });
  });
if (process.env.CYEZ_USER_DATA)
  app.setPath("userData", process.env.CYEZ_USER_DATA);
app.disableHardwareAcceleration();
let coordinator: Coordinator | undefined;
let adapter: ReaderAdapter | undefined;
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
      backgroundColor: "#f7f8fb",
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
    const renderer = pathToFileURL(
      join(location, "../renderer/index.html"),
    ).href;
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
    if (config.readerModule) {
      const mod = await import(pathToFileURL(config.readerModule).href);
      adapter = await mod.createReader();
      if (!adapter) throw new Error("READER_ADAPTER_INVALID");
      await adapter.start(
        (uid) => {
          void coordinator!.reader.accept(uid).catch(() =>
            coordinator!.log({
              source: "reader",
              level: "error",
              code: "READER_FAILED",
            }),
          );
        },
        () => {
          coordinator!.readerState = "读卡器异常";
        },
      );
      coordinator.readerState = "读卡器已连接";
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
      "请提供有效的 client-config.json，并检查本地存储。生产环境需配置真实读卡适配器。",
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
