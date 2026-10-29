import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: ["@record/protocol", "@record/client-sdk", "@series/electron"],
      },
      rollupOptions: { input: "src/main/index.ts" },
    },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: ["@series/electron"] },
      rollupOptions: {
        input: "src/preload/index.ts",
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    plugins: [react()],
    build: { rollupOptions: { input: "src/renderer/index.html" } },
  },
});
