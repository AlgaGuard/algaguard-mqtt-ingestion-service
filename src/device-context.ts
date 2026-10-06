import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { DeviceContextError, type DeviceContext } from "./domain.js";
import {
  createServiceTokenProvider,
  metadataWithServiceToken,
} from "./grpc-client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEVICE_STATUS_NAME: Record<number, "ACTIVE"> = { 5: "ACTIVE" };

const deviceContextSchema = z
  .object({
    schema: z.literal("urn:algaguard:schema:internal:device-context:v1"),
    schemaVersion: z.literal("1.0.0"),
    deviceUuid: z.string().uuid(),
    deviceId: z.string().regex(/^AG-[0-9]{6}$/),
    organizationId: z.string().uuid(),
    status: z.literal("ACTIVE"),
    ownershipVersion: z.string().regex(/^[1-9][0-9]{0,19}$/),
    resolvedAt: z.string().datetime(),
    tankId: z.string().uuid().optional(),
    contextVersion: z
      .string()
      .regex(/^[1-9][0-9]{0,19}$/)
      .optional(),
  })
  .strict();

let cachedToken: { value: string; expiresAt: number } | undefined;

async function serviceToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 10_000) {
    return cachedToken.value;
  }
  const issuer =
    process.env.KEYCLOAK_ISSUER ?? "http://keycloak:8080/realms/algaguard";
  const tokenUrl =
    process.env.KEYCLOAK_TOKEN_URL ?? `${issuer}/protocol/openid-connect/token`;
  const secret = process.env.SERVICE_CLIENT_SECRET;
  if (!secret) throw new Error("SERVICE_CLIENT_SECRET is required");
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id:
        process.env.SERVICE_CLIENT_ID ?? "algaguard-mqtt-ingestion-service",
      client_secret: secret,
    }),
  });
  if (!response.ok) throw new Error("Service authentication failed");
  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!body.access_token) throw new Error("Service token response invalid");
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 30) * 1000,
  };
  return cachedToken.value;
}

export async function resolveDeviceContext(
  deviceId: string,
): Promise<DeviceContext> {
  const baseUrl =
    process.env.DEVICE_SERVICE_URL ?? "http://device-service:3000";
  const response = await fetch(
    `${baseUrl}/v1/internal/devices/by-device-id/${encodeURIComponent(deviceId)}/context`,
    {
      headers: {
        authorization: `Bearer ${await serviceToken()}`,
      },
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { code?: string };
    throw new DeviceContextError(
      body.code ??
        (response.status === 404
          ? "DEVICE_NOT_FOUND"
          : "DEVICE_CONTEXT_REJECTED"),
    );
  }
  const context = deviceContextSchema.parse(await response.json());
  if (context.deviceId !== deviceId) {
    throw new DeviceContextError("INVALID_DEVICE_CONTEXT");
  }
  return context;
}

export function resetDeviceContextTokenForTests() {
  cachedToken = undefined;
}

export function createGrpcDeviceContextResolver(
  address: string,
  environment: NodeJS.ProcessEnv = process.env,
  tokenProvider = createServiceTokenProvider(environment),
) {
  const protoPath = path.resolve(here, "..", "proto", "device_service.proto");
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [path.dirname(protoPath)],
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as any;
  const client = new proto.algaguard.device.v1.DeviceLookupService(
    address,
    grpc.credentials.createInsecure(),
  );
  return async (deviceId: string): Promise<DeviceContext> => {
    const metadata = await metadataWithServiceToken(tokenProvider);
    const response = await new Promise<any>((resolve, reject) => {
      client.getContextByDeviceId(
        { deviceId },
        metadata,
        (error: grpc.ServiceError, value: unknown) =>
          error ? reject(error) : resolve(value),
      );
    }).catch((error: grpc.ServiceError) => {
      const [domainCode] = error.metadata?.get("x-domain-error-code") ?? [];
      if (typeof domainCode === "string")
        throw new DeviceContextError(domainCode);
      if (error.code === grpc.status.NOT_FOUND)
        throw new DeviceContextError("DEVICE_NOT_FOUND");
      throw new DeviceContextError("DEVICE_CONTEXT_REJECTED");
    });
    const context = deviceContextSchema.parse({
      schema: "urn:algaguard:schema:internal:device-context:v1",
      schemaVersion: "1.0.0",
      deviceUuid: response.deviceUuid,
      deviceId: response.deviceId,
      organizationId: response.organizationId,
      status: DEVICE_STATUS_NAME[response.status] ?? "ACTIVE",
      ownershipVersion: response.ownershipVersion,
      resolvedAt: response.resolvedAt,
      ...(response.tankId ? { tankId: response.tankId } : {}),
      ...(response.contextVersion
        ? { contextVersion: response.contextVersion }
        : {}),
    });
    if (context.deviceId !== deviceId) {
      throw new DeviceContextError("INVALID_DEVICE_CONTEXT");
    }
    return context;
  };
}
