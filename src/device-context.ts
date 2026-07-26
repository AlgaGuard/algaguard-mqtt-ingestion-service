import { z } from "zod";
import { DeviceContextError, type DeviceContext } from "./domain.js";

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
