import { fileURLToPath } from "node:url";
export const aliases = {
  "@record/protocol/identity": fileURLToPath(
    new URL("./packages/protocol/src/identity.ts", import.meta.url),
  ),
  "@record/protocol": fileURLToPath(
    new URL("./packages/protocol/src/index.ts", import.meta.url),
  ),
  "@record/domain": fileURLToPath(
    new URL("./packages/domain/src/index.ts", import.meta.url),
  ),
  "@record/client-sdk": fileURLToPath(
    new URL("./packages/client-sdk/src/index.ts", import.meta.url),
  ),
  "@record/ui": fileURLToPath(
    new URL("./packages/ui/src/index.ts", import.meta.url),
  ),
};
