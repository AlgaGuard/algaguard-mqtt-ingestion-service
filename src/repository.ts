import pg from "pg";
import type {
  IngestionRecord,
  IngestionRepository,
  TelemetryOutcome,
} from "./domain.js";

function toRecord(row: Record<string, unknown>): IngestionRecord {
  return {
    messageId: String(row.message_id),
    deviceId: String(row.device_id),
    topic: String(row.topic),
    batchId: String(row.batch_id),
    outcome: row.outcome as TelemetryOutcome,
    acceptedAt: new Date(row.accepted_at as Date | string).toISOString(),
  };
}

export class PostgresIngestionRepository implements IngestionRepository {
  constructor(readonly pool: pg.Pool) {}

  async find(messageId: string) {
    const result = await this.pool.query(
      "SELECT * FROM ingestion_messages WHERE message_id = $1 AND outcome IS NOT NULL",
      [messageId],
    );
    return result.rows[0]
      ? toRecord(result.rows[0] as Record<string, unknown>)
      : undefined;
  }

  async record(value: Omit<IngestionRecord, "acceptedAt">) {
    await this.pool.query(
      `INSERT INTO ingestion_messages(message_id, device_id, topic, batch_id, outcome)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT(message_id) DO NOTHING`,
      [
        value.messageId,
        value.deviceId,
        value.topic,
        value.batchId,
        JSON.stringify(value.outcome),
      ],
    );
    const stored = await this.find(value.messageId);
    if (!stored) throw new Error("Ingestion outcome was not persisted");
    return stored;
  }

  async health() {
    await this.pool.query("SELECT 1");
  }

  async close() {
    await this.pool.end();
  }
}
