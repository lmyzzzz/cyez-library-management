import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig(({ command, mode }) => {
  const development = command === "serve";
  const testFeatures = development || mode === "integration";
  const define = { __CYEZ_TEST_FEATURES__: JSON.stringify(testFeatures) };
  const fromRoot = (path: string) =>
    fileURLToPath(new URL(`../../${path}`, import.meta.url));
  if (development) {
    process.env.CYEZ_CLIENT_CONFIG ??= fromRoot(
      "config/client.integration.json",
    );
    process.env.CYEZ_USER_DATA ??= fromRoot("runtime/teacher-dev");
  }
  const alias: Record<string, string> = development
    ? {
        "@record/protocol/identity": fromRoot(
          "packages/protocol/src/identity.ts",
        ),
        "@record/protocol": fromRoot("packages/protocol/src/index.ts"),
        "@record/client-sdk": fromRoot("packages/client-sdk/src/index.ts"),
        "@record/ui": fromRoot("packages/ui/src/index.ts"),
      }
    : {};
  return {
    main: {
      define,
      resolve: { alias },
      build: {
        sourcemap: false,
        minify: !testFeatures,
        externalizeDeps: {
          exclude: [
            "@record/protocol",
            "@record/client-sdk",
            "@series/electron",
          ],
        },
        rollupOptions: { input: "src/main/index.ts" },
      },
    },
    preload: {
      define,
      build: {
        sourcemap: false,
        minify: !testFeatures,
        externalizeDeps: { exclude: ["@series/electron"] },
        rollupOptions: {
          input: "src/preload/index.ts",
          output: { format: "cjs", entryFileNames: "index.cjs" },
        },
      },
    },
    renderer: {
      define,
      resolve: { alias },
      server: { host: "127.0.0.1" },
      plugins: [
        react(),
        {
          name: "local-development-csp",
          apply: "serve",
          transformIndexHtml(html) {
            return html
              .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
              .replace(
                "connect-src 'none'",
                "connect-src 'self' ws://127.0.0.1:*",
              );
          },
        },
      ],
      build: {
        sourcemap: false,
        rollupOptions: { input: "src/renderer/index.html" },
      },
    },
  };
});
