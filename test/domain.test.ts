import test from "node:test";
import assert from "node:assert/strict";
import {
  DeviceContextError,
  IngestionService,
  MemoryIngestionRepository,
} from "../src/domain.js";
import { acceptedOutcome, activeContext, envelope } from "./fixtures.js";

const resolve = async () => activeContext;

test("application ACK is returned only after the durable forward completes", async () => {
  const calls: string[] = [];
  const repository = new MemoryIngestionRepository();
  const result = await new IngestionService(repository, resolve).ingest(
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
  const firstService = new IngestionService(repository, resolve);
  await firstService.ingest(
    "algaguard/v1/devices/AG-000001/telemetry",
    envelope,
    "AG-000001",
    async () => acceptedOutcome,
  );
  const restartedService = new IngestionService(repository, resolve);
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
  const service = new IngestionService(
    new MemoryIngestionRepository(),
    resolve,
  );
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
  const service = new IngestionService(
    new MemoryIngestionRepository(),
    resolve,
  );
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
  const service = new IngestionService(
    new MemoryIngestionRepository(),
    resolve,
  );
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

test("trusted context is forwarded without changing canonical MQTT identity", async () => {
  let forwarded: unknown;
  const service = new IngestionService(
    new MemoryIngestionRepository(),
    resolve,
  );
  await service.ingest(
    "algaguard/v1/devices/AG-000001/telemetry",
    envelope,
    "AG-000001",
    async (value) => {
      forwarded = value;
      return acceptedOutcome;
    },
  );
  assert.deepEqual(forwarded, {
    batchId: envelope.payload.batchId,
    deviceUuid: activeContext.deviceUuid,
    deviceId: envelope.deviceId,
    organizationId: activeContext.organizationId,
    ownershipVersion: "1",
    correlationId: envelope.messageId,
    activeProfile: envelope.payload.activeProfile,
    samples: envelope.payload.samples,
  });
});

test("unknown and inactive contexts are rejected without forwarding", async () => {
  let forwarded = false;
  for (const code of ["DEVICE_NOT_FOUND", "DEVICE_INACTIVE"]) {
    const service = new IngestionService(
      new MemoryIngestionRepository(),
      async () => {
        throw new DeviceContextError(code);
      },
    );
    const result = await service.ingest(
      "algaguard/v1/devices/AG-000001/telemetry",
      envelope,
      "AG-000001",
      async () => {
        forwarded = true;
        return acceptedOutcome;
      },
    );
    assert.equal(result.status, "REJECTED");
    assert.equal(result.reason, code);
  }
  assert.equal(forwarded, false);
});

test("device organization injection is rejected before context resolution", async () => {
  let resolved = false;
  const service = new IngestionService(
    new MemoryIngestionRepository(),
    async () => {
      resolved = true;
      return activeContext;
    },
  );
  const result = await service.ingest(
    "algaguard/v1/devices/AG-000001/telemetry",
    { ...envelope, organizationId: activeContext.organizationId },
    "AG-000001",
    async () => acceptedOutcome,
  );
  assert.deepEqual(result, {
    status: "REJECTED",
    reason: "UNTRUSTED_ORGANIZATION_CONTEXT",
  });
  assert.equal(resolved, false);
});

test("ownership transfer is observed on the next delivery without a cache", async () => {
  let organizationId = activeContext.organizationId;
  const forwardedOrganizations: string[] = [];
  const service = new IngestionService(
    new MemoryIngestionRepository(),
    async () => ({ ...activeContext, organizationId }),
  );
  await service.ingest(
    "algaguard/v1/devices/AG-000001/telemetry",
    envelope,
    "AG-000001",
    async (value) => {
      forwardedOrganizations.push(value.organizationId);
      return acceptedOutcome;
    },
  );
  organizationId = "50000000-0000-4000-8000-000000000002";
  await service.ingest(
    "algaguard/v1/devices/AG-000001/telemetry",
    { ...envelope, messageId: "10000000-0000-4000-8000-000000000002" },
    "AG-000001",
    async (value) => {
      forwardedOrganizations.push(value.organizationId);
      return acceptedOutcome;
    },
  );
  assert.deepEqual(forwardedOrganizations, [
    activeContext.organizationId,
    organizationId,
  ]);
});
