import { randomUUID } from "node:crypto";
import {
  studentId,
  type IdentityConfig,
  type CardScanInput,
} from "@record/protocol/identity";
import { ApiError } from "@record/protocol";
export interface CardEvent {
  scanId: string;
  studentId: string;
  hashVersion: string;
  card: CardScanInput;
  source: "reader" | "integration";
}
export class CardReader {
  private last: { id: string; time: number } | undefined;
  constructor(
    private config: IdentityConfig | null,
    private emit: (event: CardEvent) => Promise<void>,
    private now = performance.now.bind(performance),
  ) {}
  get configured() {
    return this.config !== null;
  }
  configure(identity: IdentityConfig) {
    if (this.config) throw new ApiError("IDENTITY_ALREADY_CONFIGURED", 409);
    this.config = identity;
  }
  async accept(uid: Uint8Array, source: "reader" | "integration" = "reader") {
    if (!this.config) {
      uid.fill(0);
      throw new ApiError("IDENTITY_CONFIG_REQUIRED", 409);
    }
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
