import test from "node:test";
import assert from "node:assert/strict";
import { IngestionService } from "../src/domain.js";
const envelope = {
  schema: "urn:test",
  schemaVersion: "1.0.0",
  messageId: "10000000-0000-4000-8000-000000000001",
  deviceId: "AG-000001",
  payload: {},
};
test("application ACK is returned only after durable forward completes", async () => {
  const calls: string[] = [];
  const result = await new IngestionService().ingest(
    "algaguard/v1/devices/AG-000001/telemetry",
    envelope,
    async () => {
      calls.push("commit");
    },
  );
  assert.deepEqual(calls, ["commit"]);
  assert.deepEqual(result, { status: "ACCEPTED", applicationAck: true });
});
test("topic/device mismatch is rejected", async () => {
  const result = await new IngestionService().ingest(
    "algaguard/v1/devices/AG-000002/telemetry",
    envelope,
    async () => undefined,
  );
  assert.equal(result.status, "REJECTED");
});
