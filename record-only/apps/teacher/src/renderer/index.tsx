import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { AppearanceProvider, createAppearanceController } from "@record/ui";
import "@series/ui/styles.css";
import "@series/ui/app.css";
import "./style.css";
import { windowRole } from "../shared/windows.js";
import { App } from "./App.js";
import { ScanWindow } from "./ScanWindow.js";
import { StatusWindow } from "./StatusWindow.js";
window.addEventListener("error", () => {
  void window.library.call("uiError", {}).catch(() => {});
});
window.addEventListener("unhandledrejection", () => {
  void window.library.call("uiError", {}).catch(() => {});
});
const appearance = createAppearanceController({ defaults: { theme: "light" } });
// 三个窗口共用同一份 renderer，由主进程通过 ?window= 指定角色。
const role = windowRole(window.location.search);
document.title =
  role === "scan"
    ? "图书馆使用登记 · 刷卡"
    : role === "status"
      ? "图书馆使用登记 · 使用状态"
      : "图书馆使用登记 · 管理后台";
createRoot(document.getElementById("root")!).render(
  <AppearanceProvider controller={appearance}>
    {role === "scan" ? (
      <ScanWindow />
    ) : role === "status" ? (
      <StatusWindow />
    ) : (
      <HashRouter>
        <App />
      </HashRouter>
    )}
  </AppearanceProvider>,
);
