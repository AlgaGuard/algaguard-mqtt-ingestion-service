import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { IngestionService } from "../src/domain.js";
import { PostgresIngestionRepository } from "../src/repository.js";
import { acceptedOutcome, envelope } from "./fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "PostgreSQL preserves idempotency outcome across a process-style restart",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const pool1 = new pg.Pool({ connectionString: databaseUrl });
    await pool1.query("TRUNCATE ingestion_messages");
    const repository1 = new PostgresIngestionRepository(pool1);
    let forwards = 0;
    const first = await new IngestionService(repository1).ingest(
      "algaguard/v1/devices/AG-000001/telemetry",
      envelope,
      "AG-000001",
      async () => {
        forwards += 1;
        return acceptedOutcome;
      },
    );
    assert.equal(first.status, "ACCEPTED");
    await repository1.close();

    const pool2 = new pg.Pool({ connectionString: databaseUrl });
    const repository2 = new PostgresIngestionRepository(pool2);
    const duplicate = await new IngestionService(repository2).ingest(
      "algaguard/v1/devices/AG-000001/telemetry",
      envelope,
      "AG-000001",
      async () => {
        forwards += 1;
        return acceptedOutcome;
      },
    );
    assert.equal(duplicate.status, "DUPLICATE");
    assert.equal(forwards, 1);
    const count = await pool2.query(
      "SELECT count(*)::int AS count FROM ingestion_messages",
    );
    assert.equal(count.rows[0]?.count, 1);
    await repository2.close();
  },
);
