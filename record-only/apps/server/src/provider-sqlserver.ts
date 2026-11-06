import sql from "mssql";
import {
  ApiError,
  profileSchema,
  type Profile,
  type SqlServerProviderConfig,
} from "@record/protocol";
import type { CardScanInput } from "@record/protocol/identity";
import type { CampusProvider } from "./provider.js";

const view = "[Concard].[dbo].[v_ViewCardInfo]";

export function uidForSqlServer(uidHex: string, encoding: "hex8" | "decimal") {
  if (!/^[0-9a-f]{8}$/.test(uidHex))
    throw new ApiError("CARD_FORMAT_INVALID", 422);
  return encoding === "hex8" ? uidHex : BigInt(`0x${uidHex}`).toString(10);
}

export function lookupQuery(limit: 0 | 2) {
  // Fixed external read-only contract. Never SELECT *, metadata, account or ID columns.
  return `SELECT TOP (${limit}) [卡号] AS [card], [姓名] AS [name], [班级] AS [className] FROM ${view} WHERE [卡号] = @uid`;
}

export class SqlServerCampusProvider implements CampusProvider {
  constructor(
    private readonly config: SqlServerProviderConfig,
    private readonly timeoutMs: number,
  ) {}

  private pool() {
    return new sql.ConnectionPool({
      server: this.config.host,
      port: this.config.port,
      database: "Concard",
      user: this.config.username,
      password: this.config.password,
      connectionTimeout: this.timeoutMs,
      requestTimeout: this.timeoutMs,
      pool: { max: 1, min: 0, idleTimeoutMillis: 1000 },
      options: {
        encrypt: true,
        trustServerCertificate:
          this.config.tlsValidation === "trustServerCertificate",
        enableArithAbort: true,
        cryptoCredentialsDetails: this.config.caPem
          ? { ca: this.config.caPem }
          : undefined,
      },
    });
  }

  private async run(limit: 0 | 2, uid: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const pool = this.pool();
    let request: sql.Request | undefined;
    const cancel = () => request?.cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await pool.connect();
      signal?.throwIfAborted();
      request = pool.request();
      request.input("uid", sql.VarChar(20), uid);
      return await request.query<Record<string, unknown>>(lookupQuery(limit));
    } finally {
      signal?.removeEventListener("abort", cancel);
      await pool.close();
    }
  }

  async probe() {
    try {
      await this.run(0, "00000000");
    } catch {
      throw new ApiError("PROVIDER_CONFIGURATION_INVALID", 422);
    }
  }

  async lookup(
    card: Readonly<CardScanInput>,
    signal: AbortSignal,
  ): Promise<Profile> {
    let rows: Record<string, unknown>[] = [];
    try {
      const uid = uidForSqlServer(card.uidHex, this.config.uidEncoding);
      rows = (await this.run(2, uid, signal)).recordset;
      if (rows.length === 0) throw new ApiError("STUDENT_NOT_ALLOWED", 403);
      if (rows.length !== 1) throw new ApiError("PROFILE_MISMATCH", 422);
      const row = rows[0];
      if (typeof row.card !== "string" || row.card.toLowerCase() !== uid)
        throw new ApiError("PROFILE_MISMATCH", 422);
      const value = profileSchema.safeParse({
        name: row.name,
        className: row.className,
        schoolNumber: "",
      });
      if (!value.success) throw new ApiError("PROFILE_MISMATCH", 422);
      return value.data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("PROVIDER_UNAVAILABLE", 503);
    } finally {
      for (const row of rows)
        for (const key of Object.keys(row)) row[key] = undefined;
    }
  }
}
