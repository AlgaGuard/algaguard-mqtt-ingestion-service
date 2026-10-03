import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { createGrpcDeviceContextResolver } from "../src/device-context.js";
import { DeviceContextError } from "../src/domain.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function loadProto(file: string) {
  const protoPath = path.resolve(here, "..", "proto", file);
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [path.dirname(protoPath)],
  });
  return grpc.loadPackageDefinition(packageDefinition) as any;
}

function withFakeTokenEndpoint(
  testFn: (environment: NodeJS.ProcessEnv) => Promise<void>,
) {
  return async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      if (String(input).includes("/protocol/openid-connect/token"))
        return new Response(
          JSON.stringify({ access_token: "fake-token", expires_in: 300 }),
          { status: 200 },
        );
      return originalFetch(input);
    }) as typeof fetch;
    try {
      await testFn({
        SERVICE_CLIENT_SECRET: "test-secret",
        SERVICE_CLIENT_ID: "algaguard-mqtt-ingestion-service",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  };
}

async function startFakeDeviceService(
  handler: (
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>,
  ) => void,
) {
  const proto = loadProto("device_service.proto");
  const server = new grpc.Server();
  server.addService(proto.algaguard.device.v1.DeviceLookupService.service, {
    getContextByDeviceId: handler,
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, boundPort) => (error ? reject(error) : resolve(boundPort)),
    );
  });
  return {
    address: `127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => server.tryShutdown(() => resolve())),
  };
}

test(
  "createGrpcDeviceContextResolver resolves an active device's context",
  withFakeTokenEndpoint(async (environment) => {
    const deviceUuid = randomUUID();
    const organizationId = randomUUID();
    const { address, stop } = await startFakeDeviceService((call, callback) => {
      callback(null, {
        deviceUuid,
        deviceId: call.request.deviceId,
        organizationId,
        status: 5, // ACTIVE
        ownershipVersion: "1",
        resolvedAt: new Date().toISOString(),
        tankId: "",
        contextVersion: "1",
      });
    });
    try {
      const resolve = createGrpcDeviceContextResolver(address, environment);
      const context = await resolve("AG-000001");
      assert.equal(context.deviceUuid, deviceUuid);
      assert.equal(context.organizationId, organizationId);
    } finally {
      await stop();
    }
  }),
);

test(
  "createGrpcDeviceContextResolver preserves the exact revoked-device error code from the metadata trailer",
  withFakeTokenEndpoint(async (environment) => {
    const { address, stop } = await startFakeDeviceService(
      (_call, callback) => {
        const metadata = new grpc.Metadata();
        metadata.set("x-domain-error-code", "DEVICE_REVOKED");
        callback(
          Object.assign(new Error("Device is revoked"), {
            code: grpc.status.FAILED_PRECONDITION,
            metadata,
          }),
        );
      },
    );
    try {
      const resolve = createGrpcDeviceContextResolver(address, environment);
      await assert.rejects(
        () => resolve("AG-000001"),
        (error: DeviceContextError) => {
          assert.ok(error instanceof DeviceContextError);
          assert.equal(error.code, "DEVICE_REVOKED");
          return true;
        },
      );
    } finally {
      await stop();
    }
  }),
);

test(
  "createGrpcDeviceContextResolver falls back to DEVICE_NOT_FOUND when no metadata trailer is present",
  withFakeTokenEndpoint(async (environment) => {
    const { address, stop } = await startFakeDeviceService(
      (_call, callback) => {
        callback(
          Object.assign(new Error("not found"), {
            code: grpc.status.NOT_FOUND,
          }),
        );
      },
    );
    try {
      const resolve = createGrpcDeviceContextResolver(address, environment);
      await assert.rejects(
        () => resolve("AG-000001"),
        (error: DeviceContextError) => {
          assert.equal(error.code, "DEVICE_NOT_FOUND");
          return true;
        },
      );
    } finally {
      await stop();
    }
  }),
);
