import assert from "node:assert/strict";
import test from "node:test";
import {
  resetDeviceContextTokenForTests,
  resolveDeviceContext,
} from "../src/device-context.js";
import { activeContext } from "./fixtures.js";

test("Device Service context resolution uses client credentials and validates identity", async () => {
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.SERVICE_CLIENT_SECRET;
  process.env.SERVICE_CLIENT_SECRET = "test-only-secret";
  resetDeviceContextTokenForTests();
  const calls: Array<{ url: string; authorization: string | undefined }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      authorization: (init?.headers as Record<string, string> | undefined)
        ?.authorization,
    });
    if (url.endsWith("/protocol/openid-connect/token")) {
      return new Response(
        JSON.stringify({ access_token: "service-token", expires_in: 60 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(activeContext), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    assert.deepEqual(await resolveDeviceContext("AG-000001"), activeContext);
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.url, /by-device-id\/AG-000001\/context$/);
    assert.equal(calls[1]!.authorization, "Bearer service-token");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.SERVICE_CLIENT_SECRET = originalSecret;
    resetDeviceContextTokenForTests();
  }
});
