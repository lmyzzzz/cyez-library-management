import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
try {
  const config = loadConfig();
  const { app, spool } = await createApp(config);
  await app.listen({ host: config.host, port: config.port });
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => process.exit(1), 15000);
    timer.unref();
    try {
      await app.close();
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
    }
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await spool.append({
    logId: crypto.randomUUID(),
    source: "api",
    level: "info",
    atMs: Date.now(),
    appVersion: "0.1.0",
    code: "APP_STARTED",
  });
} catch {
  process.stderr.write(
    "STARTUP_FAILED: verify configuration, adapters, database and storage.\n",
  );
  process.exitCode = 1;
}
