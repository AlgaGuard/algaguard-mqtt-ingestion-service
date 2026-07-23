import test from "node:test";
import assert from "node:assert/strict";
import { IngestionService, MemoryIngestionRepository } from "../src/domain.js";
import { acceptedOutcome, envelope } from "./fixtures.js";

test("application ACK is returned only after the durable forward completes", async () => {
  const calls: string[] = [];
  const repository = new MemoryIngestionRepository();
  const result = await new IngestionService(repository).ingest(
    "algaguard/v1/devices/AG-000001/telemetry",
    envelope,
    "AG-000001",
    async () => {
      calls.push("durable-telemetry-commit");
      return acceptedOutcome;
    },
  );
  assert.deepEqual(calls, ["durable-telemetry-commit"]);
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.applicationAck, true);
  assert.ok(await repository.find(envelope.messageId));
});

test("a persisted message is duplicate after service reconstruction and is not forwarded", async () => {
  const repository = new MemoryIngestionRepository();
  const firstService = new IngestionService(repository);
  await firstService.ingest(
    "algaguard/v1/devices/AG-000001/telemetry",
    envelope,
    "AG-000001",
    async () => acceptedOutcome,
  );
  const restartedService = new IngestionService(repository);
  const result = await restartedService.ingest(
    "algaguard/v1/devices/AG-000001/telemetry",
    envelope,
    "AG-000001",
    async () => {
      throw new Error("duplicate must not be forwarded");
    },
  );
  assert.equal(result.status, "DUPLICATE");
  assert.equal(result.outcome.duplicate, true);
});

test("topic, payload, and authenticated device identity must all match", async () => {
  const service = new IngestionService(new MemoryIngestionRepository());
  const result = await service.ingest(
    "algaguard/v1/devices/AG-000002/telemetry",
    envelope,
    "AG-000002",
    async () => acceptedOutcome,
  );
  assert.deepEqual(result, {
    status: "REJECTED",
    reason: "DEVICE_TOPIC_IDENTITY_MISMATCH",
  });
});

test("invalid contract messages are rejected before forwarding", async () => {
  let forwarded = false;
  const service = new IngestionService(new MemoryIngestionRepository());
  const result = await service.ingest(
    "algaguard/v1/devices/AG-000001/telemetry",
    { ...envelope, payload: { ...envelope.payload, sampleCount: 2 } },
    "AG-000001",
    async () => {
      forwarded = true;
      return acceptedOutcome;
    },
  );
  assert.equal(result.status, "REJECTED");
  assert.equal(forwarded, false);
});

test("dependency retry attempts are observable", async () => {
  const service = new IngestionService(new MemoryIngestionRepository());
  await service.ingest(
    "algaguard/v1/devices/AG-000001/telemetry",
    envelope,
    "AG-000001",
    async (_value, onRetry) => {
      onRetry();
      onRetry();
      return acceptedOutcome;
    },
  );
  assert.match(service.metrics.render(), /algaguard_ingestion_retry_total 2/);
});
