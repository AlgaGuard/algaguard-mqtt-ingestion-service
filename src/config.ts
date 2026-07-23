import { z } from "zod";

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().min(1),
    HTTP_BODY_LIMIT: z
      .string()
      .regex(/^[1-9][0-9]*(kb|mb)$/i)
      .default("256kb"),
    MQTT_URL: z.string().url().optional(),
    MQTT_CLIENT_ID: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/)
      .default("algaguard-mqtt-ingestion-service"),
    MQTT_CA_PATH: z.string().min(1).optional(),
    MQTT_CERTIFICATE_PATH: z.string().min(1).optional(),
    MQTT_PRIVATE_KEY_PATH: z.string().min(1).optional(),
    MQTT_SERVER_NAME: z.string().min(1).max(253).optional(),
    MQTT_MAX_PACKET_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(1_048_576)
      .default(262_144),
    MQTT_MAX_SAMPLES_PER_BATCH: z.coerce
      .number()
      .int()
      .min(1)
      .max(120)
      .default(120),
    MQTT_QOS1_INFLIGHT: z.coerce.number().int().min(1).max(1024).default(32),
    MQTT_KEEPALIVE_SECONDS: z.coerce
      .number()
      .int()
      .min(15)
      .max(3600)
      .default(60),
    MQTT_SESSION_EXPIRY_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .max(604_800)
      .default(3600),
    MQTT_RECONNECT_DELAY_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(2000),
    MQTT_MAX_MESSAGES_PER_SECOND: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(200),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
  })
  .superRefine((value, context) => {
    if (!value.MQTT_URL) return;
    if (!value.MQTT_URL.startsWith("mqtts://"))
      context.addIssue({
        code: "custom",
        path: ["MQTT_URL"],
        message: "authenticated ingestion requires mqtts",
      });
    for (const key of [
      "MQTT_CA_PATH",
      "MQTT_CERTIFICATE_PATH",
      "MQTT_PRIVATE_KEY_PATH",
      "MQTT_SERVER_NAME",
    ] as const)
      if (!value[key])
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required when MQTT_URL is configured`,
        });
  });
export type ServiceConfig = z.infer<typeof environmentSchema>;
export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  return environmentSchema.parse(environment);
}
