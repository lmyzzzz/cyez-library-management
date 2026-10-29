import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { AppearanceProvider, createAppearanceController } from "@record/ui";
import "@series/ui/styles.css";
import "@series/ui/app.css";
import "./style.css";
import { App } from "./App.js";
window.addEventListener("error", () => {
  void window.library.call("uiError", {}).catch(() => {});
});
window.addEventListener("unhandledrejection", () => {
  void window.library.call("uiError", {}).catch(() => {});
});
const appearance = createAppearanceController({ defaults: { theme: "light" } });
createRoot(document.getElementById("root")!).render(
  <AppearanceProvider controller={appearance}>
    <HashRouter>
      <App />
    </HashRouter>
  </AppearanceProvider>,
);
