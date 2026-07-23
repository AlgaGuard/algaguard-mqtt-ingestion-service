# AlgaGuard MQTT ingestion service

The service subscribes only to the canonical device telemetry topic, validates the complete Phase 2 telemetry contract, binds the topic and payload device IDs to the broker-authenticated identity, resolves the authoritative UUID and organization context from Device Service, forwards the enriched batch using an OIDC client-credentials token, and publishes the exact application acknowledgement returned after the telemetry service commits durably. Device-provided `organizationId` values are rejected.

Device context is resolved for every valid delivery. There is intentionally no local ownership cache, so a lifecycle change or transfer is effective on the next delivery without an invalidation race. Resolution and rejection counters are exposed with the existing ingestion metrics.

Message outcomes are stored in PostgreSQL by `messageId`, so delivery retries remain idempotent after process or database-client restarts. The ingestion subscriber itself uses a separately scoped service certificate over `mqtts`; device shared credentials are never accepted. Only that protected subscriber constructs the broker-authenticated identity value. HTTP requests carrying proxy identity headers are rejected, and the EMQX ACL configuration is responsible for binding each authenticated device principal to its own topic segment.

MQTT packet size, batch samples, QoS1 inflight count, keepalive, session expiry, reconnect delay, and message rate are bounded and environment-configurable. Metrics separately expose mTLS-accepted deliveries, credential mismatches, revoked/expired context rejections, and topic identity mismatches. Certificate bodies and private keys are not logged.

## Validate

```sh
npm ci
npm run migrate
npm run check
docker build -t algaguard-mqtt-ingestion-service:local .
```

`npm run check` runs formatting, TypeScript, contract fixture validation, unit tests, restart integration tests when `TEST_DATABASE_URL` is set, and the production build. Copy `.env.example` for local configuration and replace every placeholder through a secret manager.

This is a platform implementation with simulated/database integration evidence. It does not claim production deployment, physical-device MQTT validation, MicroSD validation, or battery validation.
