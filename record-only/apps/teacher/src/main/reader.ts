import { randomUUID } from "node:crypto";
import {
  studentId,
  type IdentityConfig,
  type CardScanInput,
} from "@record/protocol/identity";
export interface CardEvent {
  scanId: string;
  studentId: string;
  hashVersion: string;
  card: CardScanInput;
  source: "reader" | "integration";
}
export interface ReaderAdapter {
  start(accept: (uid: Uint8Array) => void, onError: () => void): Promise<void>;
  stop(): Promise<void>;
}
export class CardReader {
  private last: { id: string; time: number } | undefined;
  constructor(
    private config: IdentityConfig,
    private emit: (event: CardEvent) => Promise<void>,
    private now = performance.now.bind(performance),
  ) {}
  async accept(uid: Uint8Array, source: "reader" | "integration" = "reader") {
    const card = {
      issuer: this.config.issuer,
      uidHex: Buffer.from(uid).toString("hex"),
    };
    uid.fill(0);
    try {
      const id = studentId(card, this.config);
      const time = this.now();
      if (this.last?.id === id && time - this.last.time < 1200) return;
      this.last = { id, time };
      await this.emit({
        scanId: randomUUID(),
        studentId: id,
        hashVersion: this.config.hashVersion,
        card,
        source,
      });
    } finally {
      card.uidHex = "";
      card.issuer = "";
    }
  }
}
