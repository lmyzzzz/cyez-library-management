import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ApiError,
  sqlServerProviderSchema,
  type SqlServerProviderConfig,
} from "@record/protocol";
import { SerialKeys } from "@record/domain";
import type { Context } from "./previews.js";
import type { CampusProvider } from "./provider.js";
import { SqlServerCampusProvider } from "./provider-sqlserver.js";
import type { Database } from "./database.js";

const aad = Buffer.from("cyez-record-only/provider-config/v1");
type LiveProvider = CampusProvider & { probe(): Promise<void> };
export type ProviderFactory = (config: SqlServerProviderConfig) => LiveProvider;

export class ProviderSettings {
  private current: LiveProvider | undefined;
  private serial = new SerialKeys();
  get configured() {
    return !!this.current;
  }
  readonly provider: CampusProvider = {
    lookup: (card, signal) => {
      if (!this.current) throw new ApiError("PROVIDER_UNAVAILABLE", 503);
      return this.current.lookup(card, signal);
    },
  };

  private constructor(
    private readonly db: Database,
    private readonly key: Buffer,
    private readonly factory: ProviderFactory,
  ) {}

  static async create(
    db: Database,
    keyFile: string,
    timeoutMs: number,
    factory: ProviderFactory = (config) =>
      new SqlServerCampusProvider(config, timeoutMs),
  ) {
    const text = (await readFile(keyFile, "utf8")).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(text))
      throw new Error("PROVIDER_CONFIG_KEY_INVALID");
    const settings = new ProviderSettings(
      db,
      Buffer.from(text, "hex"),
      factory,
    );
    const row = await db.providerConfigs.findByPk("campus");
    if (row) settings.current = factory(settings.open(row.get().sealed));
    return settings;
  }

  private seal(value: SqlServerProviderConfig) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return [
      "v1",
      nonce.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      encrypted.toString("base64url"),
    ].join(".");
  }

  private open(sealed: string): SqlServerProviderConfig {
    try {
      const [version, nonce, tag, data, extra] = sealed.split(".");
      if (version !== "v1" || !nonce || !tag || !data || extra)
        throw new Error("FORMAT");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(nonce, "base64url"),
      );
      decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return sqlServerProviderSchema.parse(
        JSON.parse(
          Buffer.concat([
            decipher.update(Buffer.from(data, "base64url")),
            decipher.final(),
          ]).toString("utf8"),
        ),
      );
    } catch {
      throw new Error("PROVIDER_CONFIG_DECRYPT_FAILED");
    }
  }

  async replace(ctx: Context, value: SqlServerProviderConfig) {
    return this.serial.run("provider-config", async () => {
      const parsed = sqlServerProviderSchema.parse(value);
      const candidate = this.factory(parsed);
      await candidate.probe();
      const sealed = this.seal(parsed);
      try {
        await this.db.sequelize.transaction(async (transaction) => {
          await this.db.providerConfigs.upsert(
            { key: "campus", sealed, updatedAt: new Date() },
            { transaction },
          );
          await this.db.audits.create(
            {
              id: randomUUID(),
              actor: ctx.username,
              clientId: ctx.clientId,
              requestId: null,
              scanId: null,
              studentId: null,
              recordId: null,
              deviceId: null,
              action: "provider_config_replaced",
              fields: ["campus"],
              at: new Date(),
            },
            // The runtime role can append audits but must never read them.
            { transaction, returning: false },
          );
        });
      } catch {
        // Do not expose ORM errors, SQL, parameters or the sealed configuration.
        throw new ApiError("PROVIDER_CONFIGURATION_SAVE_FAILED", 503);
      }
      this.current = candidate;
    });
  }
}
