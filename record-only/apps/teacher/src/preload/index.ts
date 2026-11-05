import { contextBridge, ipcRenderer } from "electron";
import { createWindowControlsBridge } from "@series/electron/preload";
import type { TeacherBridge, TeacherEvent } from "../shared/bridge.js";
const bridge: TeacherBridge = {
  async call(action, input) {
    const pending = ipcRenderer.invoke("library:action", action, input);
    if (
      action === "replaceProviderConfig" &&
      input &&
      typeof input === "object"
    )
      for (const key of Object.keys(input))
        (input as Record<string, unknown>)[key] = undefined;
    const result = await pending;
    if (!result.ok) throw new Error(result.code);
    return result.value;
  },
  subscribe(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: TeacherEvent,
    ) => listener(payload);
    ipcRenderer.on("library:event", handler);
    return () => ipcRenderer.removeListener("library:event", handler);
  },
};
contextBridge.exposeInMainWorld("library", bridge);
contextBridge.exposeInMainWorld(
  "windowControls",
  createWindowControlsBridge(ipcRenderer),
);
