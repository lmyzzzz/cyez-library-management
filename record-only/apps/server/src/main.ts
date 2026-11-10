import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
try {
  const config = loadConfig();
  const api = await createApp(config);
  try {
    // The startup log must be durable before the API becomes reachable: if the
    // spool is broken, this process must fail to start rather than serve while
    // silently unable to persist diagnostics.
    await api.spool.append({
      logId: crypto.randomUUID(),
      source: "api",
      level: "info",
      atMs: Date.now(),
      appVersion: "0.1.0",
      code: "APP_STARTED",
    });
    await api.app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await api.app.close().catch(() => {});
    await api.db.close().catch(() => {});
    throw error;
  }
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => process.exit(1), 15000);
    timer.unref();
    try {
      await api.app.close();
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
    }
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} catch {
  process.stderr.write(
    "STARTUP_FAILED: verify configuration, adapters, database and storage.\n",
  );
  process.exitCode = 1;
}
