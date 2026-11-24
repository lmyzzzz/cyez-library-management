import { Op, type Transaction } from "sequelize";
import type { Service } from "../service.js";
import type { Context } from "../previews.js";
import { classGrade, type BuiltinAddon } from "./catalog.js";

/** Snapshot active candidates at the trigger cutoff; lock in the existing
 * device/student/record order, recheck under locks, and reuse normal ending. */
export async function endRecords(
  service: Service,
  ctx: Context,
  tx: Transaction,
  executor: BuiltinAddon["executor"],
  cutoff: number,
  requestId: string,
) {
  const db = service.db;
  const candidates = await db.records.findAll({
    where: {
      endedAt: null,
      startedAt: { [Op.lte]: new Date(cutoff) },
      createdAt: { [Op.lte]: new Date(cutoff) },
    },
    transaction: tx,
  });
  const ids = candidates.map((r) => r.get());
  await service.lock(
    tx,
    ids.map((r) => r.deviceId),
    ids.map((r) => r.studentId),
    ids.map((r) => r.id),
  );
  const records = [];
  for (const initial of ids) {
    const row = await db.records.findByPk(initial.id, { transaction: tx });
    if (!row || row.get().endedAt) continue; // Concurrent manual end already won.
    const record = await service.record(row.get(), tx);
    if (
      executor.kind === "end-all-records" ||
      executor.grades.includes(classGrade(record.student.className) ?? 0)
    )
      records.push(record);
  }
  await service.finish(
    ctx,
    {
      id: requestId,
      clientId: ctx.clientId,
      sessionId: ctx.sessionId,
      mode: "batch",
      atMs: cutoff,
      expiresAtMs: cutoff,
      records,
    },
    "",
    true,
    tx,
    requestId,
  );
  return { count: records.length };
}
