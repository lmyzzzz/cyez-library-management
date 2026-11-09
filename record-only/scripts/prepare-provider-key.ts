import { mkdir, writeFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";

// Compose file-based secrets keep the host owner and mode. The 0700 directory
// keeps the key private on the host; 0444 lets the non-root api container UID
// (node 1000) read the bind-mounted file. The explicit chmod also covers
// restrictive host umasks.
await mkdir("secrets", { recursive: true, mode: 0o700 });
await chmod("secrets", 0o700);
try {
  await writeFile(
    "secrets/provider-config-key",
    randomBytes(32).toString("hex"),
    {
      flag: "wx",
      mode: 0o444,
    },
  );
  await chmod("secrets/provider-config-key", 0o444);
  console.log("PROVIDER_CONFIG_KEY_CREATED");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  console.log("PROVIDER_CONFIG_KEY_EXISTS_UNCHANGED");
}
