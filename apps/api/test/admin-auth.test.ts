import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createServices } from "../src/services.js";

const path = "/api/admin/me";
const userId = "13e93656-3dcd-4ba8-9709-3f4f082d0565";

describe("admin authorization", () => {
  it.each([undefined, "Basic token", "Bearer two tokens"])(
    "rejects a missing or malformed authorization header (%s)",
    async (header) => {
      const getUserId = vi.fn();
      const isAdmin = vi.fn();
      const call = request(createApp({ getUserId, isAdmin })).get(path);
      if (header) call.set("Authorization", header);
      await call.expect(401, { error: "unauthorized" });
      expect(getUserId).not.toHaveBeenCalled();
      expect(isAdmin).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid token without querying admins", async () => {
    const getUserId = vi.fn().mockResolvedValue(null);
    const isAdmin = vi.fn();
    await request(createApp({ getUserId, isAdmin }))
      .get(path)
      .set("Authorization", "Bearer invalid")
      .expect(401);
    expect(getUserId).toHaveBeenCalledWith("invalid");
    expect(isAdmin).not.toHaveBeenCalled();
  });

  it.each([false, true])("checks admin membership (%s)", async (allowed) => {
    const getUserId = vi.fn().mockResolvedValue(userId);
    const isAdmin = vi.fn().mockResolvedValue(allowed);
    const response = await request(createApp({ getUserId, isAdmin }))
      .get(path)
      .set("Authorization", "Bearer valid")
      .expect(allowed ? 200 : 403);
    expect(isAdmin).toHaveBeenCalledWith(userId);
    expect(response.body).toEqual(
      allowed ? { role: "admin" } : { error: "forbidden" },
    );
  });

  it("fails closed when the admin lookup fails", async () => {
    const getUserId = vi.fn().mockResolvedValue(userId);
    const isAdmin = vi
      .fn()
      .mockRejectedValue(new Error("database unavailable"));
    await request(createApp({ getUserId, isAdmin }))
      .get(path)
      .set("Authorization", "Bearer valid")
      .expect(503, { error: "authentication_unavailable" });
  });

  it("fails closed when auth is unconfigured", async () => {
    await request(createApp())
      .get(path)
      .set("Authorization", "Bearer token")
      .expect(503);
  });
});

describe("admin PIN login", () => {
  it("requires a six-digit string and keeps successful session responses out of caches", async () => {
    const session = {
      access_token: "test-access",
      refresh_token: "test-refresh",
    };
    const signInWithPin = vi.fn().mockResolvedValue(session);
    const api = request(
      createApp({ getUserId: vi.fn(), isAdmin: vi.fn(), signInWithPin }),
    );
    await api.post("/api/admin/pin").send({ pin: 123456 }).expect(400);
    expect(signInWithPin).not.toHaveBeenCalled();
    await api
      .post("/api/admin/pin")
      .send({ pin: "012345" })
      .expect("Cache-Control", "no-store")
      .expect(200, session);
    expect(signInWithPin).toHaveBeenCalledWith("012345");
  });

  it("rejects incorrect PINs and limits attempts before contacting Supabase", async () => {
    const { adminAuth } = createServices({
      DATABASE_URL: "postgres://localhost/test",
      SUPABASE_URL: "https://example.test",
      SUPABASE_PUBLISHABLE_KEY: "test-key",
      ADMIN_AUTH_EMAIL: "test@example.test",
      ADMIN_AUTH_PASSWORD: "test-auth-password",
      ADMIN_PIN: "012345",
    });
    const api = request(createApp(adminAuth));
    for (let attempt = 0; attempt < 8; attempt++) {
      await api
        .post("/api/admin/pin")
        .send({ pin: "999999" })
        .expect(401, { error: "invalid_pin" });
    }
    await api
      .post("/api/admin/pin")
      .send({ pin: "012345" })
      .expect(429, { error: "pin_rate_limited" });
  });
});

it("shares concurrent Supabase token checks without caching completed checks", async () => {
  const token = "test-token";
  const email = "test@example.test";
  const fetchUser = vi.fn(async () => Response.json({ id: userId, email }));
  vi.stubGlobal("fetch", fetchUser);
  try {
    const { adminAuth } = createServices({
      DATABASE_URL: "postgres://localhost/test",
      SUPABASE_URL: "https://example.test",
      SUPABASE_PUBLISHABLE_KEY: "test-key",
      ADMIN_AUTH_EMAIL: email,
      ADMIN_AUTH_PASSWORD: "test-auth-password",
      ADMIN_PIN: "012345",
    });
    expect(
      await Promise.all([
        adminAuth!.getUserId(token),
        adminAuth!.getUserId(token),
      ]),
    ).toEqual([userId, userId]);
    expect(fetchUser).toHaveBeenCalledTimes(1);
    expect(await adminAuth!.getUserId(token)).toBe(userId);
    expect(fetchUser).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});
