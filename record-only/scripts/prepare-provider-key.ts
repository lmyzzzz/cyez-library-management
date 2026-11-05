import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

await mkdir("secrets", { recursive: true });
try {
  await writeFile(
    "secrets/provider-config-key",
    randomBytes(32).toString("hex"),
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  console.log("PROVIDER_CONFIG_KEY_CREATED");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  console.log("PROVIDER_CONFIG_KEY_EXISTS_UNCHANGED");
}
