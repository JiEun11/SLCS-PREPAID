import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

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
