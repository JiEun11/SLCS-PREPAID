import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createCustomerService } from "../src/customers.js";
import {
  customers,
  idempotencyRequests,
  transactions,
} from "../src/db/schema.js";

const actorId = "13e93656-3dcd-4ba8-9709-3f4f082d0565";
const path = "/api/customers";
const body = { name: "한글 Coffee", initialAmount: 3000 };

describe("customer API", () => {
  const client = new PGlite();
  const db = drizzle(client);
  const api = request(
    createApp(
      {
        async getUserId(token) {
          return token === "admin" ? actorId : null;
        },
        async isAdmin() {
          return true;
        },
      },
      createCustomerService(db),
    ),
  );
  const register = (key: string) =>
    api
      .post(path)
      .auth("admin", { type: "bearer" })
      .set("Idempotency-Key", key);
  const get = (url: string) => api.get(url).auth("admin", { type: "bearer" });

  beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }), 15_000);
  beforeEach(() =>
    client.exec("TRUNCATE idempotency_requests, transactions, customers"),
  );
  afterAll(() => client.close());

  it("requires admin authorization, a positive integer and a request key", async () => {
    await api.get(path).expect(401);
    await api
      .post(path)
      .auth("admin", { type: "bearer" })
      .send(body)
      .expect(400);
    for (const initialAmount of [
      undefined,
      0,
      -1,
      1.5,
      "3000",
      2_147_483_648,
    ]) {
      await register("invalid")
        .send({ ...body, initialAmount })
        .expect(400);
    }
    await register("invalid,key").send(body).expect(400);
    await register("invalid-json").type("json").send("{").expect(400);
  });

  it("atomically registers one charge and replays the same response", async () => {
    const [first, replay] = await Promise.all([
      register("first").send(body).expect(201),
      register("first").send(body).expect(201),
    ]);
    expect(replay.body).toEqual(first.body);
    expect(first.body).toMatchObject({
      customer: { name: body.name, balance: 3000 },
      transaction: { kind: "credit", amount: 3000, balanceAfter: 3000 },
    });
    expect(await db.select().from(transactions)).toEqual([
      expect.objectContaining({
        customerId: first.body.customer.id,
        actorId,
        amount: 3000,
        balanceAfter: 3000,
      }),
    ]);
    expect(await db.select().from(customers)).toHaveLength(1);
    await register("first")
      .send({ ...body, initialAmount: 100 })
      .expect(409);
  });

  it("rejects existing ledger keys without leaving a claim or customer", async () => {
    const [customer] = await db
      .insert(customers)
      .values({ name: "Legacy", balance: 1 })
      .returning();
    await db.insert(transactions).values({
      customerId: customer.id,
      actorId,
      kind: "credit",
      amount: 1,
      idempotencyKey: "legacy",
    });
    await register("legacy").send(body).expect(409);
    expect(await db.select().from(idempotencyRequests)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "legacy" })]),
    );
    expect(await db.select().from(customers)).toHaveLength(1);
  });

  it("rolls back customer and claim when charge insertion fails and allows retry", async () => {
    await client.exec(
      "ALTER TABLE transactions ADD CONSTRAINT test_failure CHECK (amount <> 51)",
    );
    try {
      await register("retry")
        .send({ name: "Retry", initialAmount: 51 })
        .expect(500, { error: "internal_error" });
      expect(await db.select().from(customers)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "Retry" })]),
      );
      expect(await db.select().from(idempotencyRequests)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ key: "retry" })]),
      );
    } finally {
      await client.exec(
        "ALTER TABLE transactions DROP CONSTRAINT test_failure",
      );
    }
    await register("retry")
      .send({ name: "Retry", initialAmount: 51 })
      .expect(201);
  });

  it("searches and pages active customers and finds details by UUID", async () => {
    const [match, deleted] = await db
      .insert(customers)
      .values([
        { name: "Literal %_ Coffee" },
        { name: "Deleted %_ Coffee", deletedAt: new Date() },
      ])
      .returning();
    await get(path)
      .query({ q: "%_ cOFFee", limit: 1 })
      .expect(200)
      .expect(({ body }) => {
        expect(body.customers).toEqual([
          expect.objectContaining({ id: match.id }),
        ]);
      });
    await get(path)
      .query({ q: "%_ cOFFee", offset: 1 })
      .expect(200, { customers: [] });
    await get(path).query({ limit: 101 }).expect(400);
    await get(path + "/" + match.id)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          id: match.id,
          name: match.name,
          balance: 0,
        });
      });
    await get(path + "/" + deleted.id).expect(404);
    await get(path + "/invalid").expect(400);
  });
  it("registers same-name customers and searches exact phone suffixes including leading zero", async () => {
    const first = await register("one")
      .send({ name: "김민지", initialAmount: 1000, phoneLast4: "0123" })
      .expect(201);
    const second = await register("two")
      .send({ name: "김민지", initialAmount: 2000, phoneLast4: "0456" })
      .expect(201);
    await register("two")
      .send({ name: "김민지", initialAmount: 2000, phoneLast4: "0456" })
      .expect(201, second.body);
    await register("two")
      .send({ name: "김민지", initialAmount: 2000, phoneLast4: "0457" })
      .expect(409);
    await register("bad")
      .send({ name: "김민지", initialAmount: 1000, phoneLast4: "01012345678" })
      .expect(400);
    const byName = await get(path).query({ q: "민지" }).expect(200);
    expect(
      byName.body.customers.map(({ id }: { id: string }) => id).sort(),
    ).toEqual([first.body.customer.id, second.body.customer.id].sort());
    await get(path)
      .query({ q: "0123" })
      .expect(200)
      .expect(({ body }) => {
        expect(body.customers).toMatchObject([
          { id: first.body.customer.id, phoneLast4: "0123" },
        ]);
      });
    await get(path).query({ q: "012" }).expect(200, { customers: [] });
    await api
      .patch(path + "/" + first.body.customer.id)
      .auth("admin", { type: "bearer" })
      .send({ name: "김민지", phoneLast4: null })
      .expect(200);
    await get(path).query({ q: "0123" }).expect(200, { customers: [] });
  });
});
