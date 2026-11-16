import {
  DataTypes as D,
  type Model,
  type ModelStatic,
  type Sequelize,
} from "sequelize";
import type { AddonId, AddonDTO } from "@record/protocol";
export interface AddonRow {
  id: AddonId;
  enabled: boolean;
  version: number;
  enabledAt: Date | null;
  lastSlot: Date | null;
  lastRun: AddonDTO["lastRun"];
}
export const addonAttributes = {
  id: { type: D.STRING(80), primaryKey: true, allowNull: false },
  enabled: { type: D.BOOLEAN, allowNull: false },
  version: { type: D.INTEGER, allowNull: false },
  enabledAt: { type: D.DATE, allowNull: true },
  lastSlot: { type: D.DATE, allowNull: true },
  lastRun: { type: D.JSONB, allowNull: true },
};
export function defineAddons(sequelize: Sequelize) {
  return sequelize.define("builtin_addons", addonAttributes) as ModelStatic<
    Model<AddonRow, AddonRow>
  >;
}
