import { randomInt } from "node:crypto";
import type { AddressInfo, Server } from "node:net";

// Port 0 can allocate Chromium-blocked ports (for example 6000) when Windows
// uses a custom dynamic range. Bind in the IANA private range without a
// check-then-bind race; do not weaken Electron's network restrictions.
export async function listenForElectron(server: Server): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(randomInt(49152, 65536), "127.0.0.1");
      });
      return (server.address() as AddressInfo).port;
    } catch (error) {
      if (
        attempt >= 19 ||
        !["EADDRINUSE", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }
}
