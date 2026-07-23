# AlgaGuard MQTT ingestion service

The service subscribes only to the canonical device telemetry topic, validates the complete Phase 2 telemetry contract, binds the topic and payload device IDs to the broker-authenticated identity, forwards valid batches using an OIDC client-credentials token, and publishes the exact application acknowledgement returned after the telemetry service commits durably.

Message outcomes are stored in PostgreSQL by `messageId`, so delivery retries remain idempotent after process or database-client restarts. Service MQTT credentials are supplied at runtime; no broker or identity secret is committed. The EMQX ACL configuration is responsible for binding each authenticated device principal to its own topic segment.

## Validate

```sh
npm ci
npm run migrate
npm run check
docker build -t algaguard-mqtt-ingestion-service:local .
```

`npm run check` runs formatting, TypeScript, contract fixture validation, unit tests, restart integration tests when `TEST_DATABASE_URL` is set, and the production build. Copy `.env.example` for local configuration and replace every placeholder through a secret manager.

This is a platform implementation with simulated/database integration evidence. It does not claim production deployment, physical-device MQTT validation, MicroSD validation, or battery validation.
