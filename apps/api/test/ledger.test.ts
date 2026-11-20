import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createCustomerService } from "../src/customers.js";
import {
  customers,
  idempotencyRequests,
  transactions,
} from "../src/db/schema.js";

const actorId = "13e93656-3dcd-4ba8-9709-3f4f082d0565";
const client = new PGlite();
const db = drizzle(client);
const api = request(
  createApp(
    {
      async getUserId(token) {
        return token === "admin" ? actorId : null;
      },
      async reauthenticate(_token, _id, password) {
        return password === "123456";
      },
      async isAdmin() {
        return true;
      },
    },
    createCustomerService(db),
  ),
);
const root = "/api/customers";
const get = (path: string) => api.get(path).auth("admin", { type: "bearer" });
const post = (path: string, key: string) =>
  api.post(path).auth("admin", { type: "bearer" }).set("Idempotency-Key", key);

beforeAll(() => migrate(db, { migrationsFolder: "./drizzle" }), 15_000);
beforeEach(() =>
  client.exec("TRUNCATE idempotency_requests, transactions, customers"),
);
afterAll(() => client.close());

async function register(initialAmount = 10_000) {
  const { body } = await post(root, "registration")
    .send({ name: "테스트 고객", initialAmount })
    .expect(201);
  return root + "/" + body.customer.id;
}

it("tracks credit, debit, latest transaction, paged history and exact totals", async () => {
  const customer = await register();
  const credit = await post(customer + "/credits", "credit")
    .send({ amount: 2500 })
    .expect(201);
  expect(credit.body.transaction).toMatchObject({
    kind: "credit",
    amount: 2500,
    balanceAfter: 12500,
  });
  const debit = await post(customer + "/debits", "debit")
    .send({ amount: 3200 })
    .expect(201);
  expect(debit.body.transaction).toMatchObject({
    kind: "debit",
    amount: -3200,
    balanceAfter: 9300,
  });
  await post(customer + "/credits", "credit")
    .send({ amount: 2500 })
    .expect(201, credit.body);
  await post(customer + "/debits", "credit")
    .send({ amount: 2500 })
    .expect(409);
  await post(customer + "/credits", "registration")
    .send({ amount: 2500 })
    .expect(409);
  const { body } = await get(root).expect(200);
  expect(body.customers[0]).toMatchObject({
    balance: 9300,
    recentTransaction: { id: debit.body.transaction.id },
  });
  await get(customer + "/transactions?limit=1&offset=1")
    .expect(200)
    .expect(({ body }) => {
      expect(body.transactions).toEqual([
        expect.objectContaining({
          ...credit.body.transaction,
          actorId,
          reversesId: null,
          reversedById: null,
        }),
      ]);
    });
  await get(root + "/summary").expect(200, {
    totalBalance: "9300",
    customerCount: "1",
    totalUsed: "3200",
  });
});

it("rejects an overdraft, including competing debits, and permits retry after a credit", async () => {
  const customer = await register(100);
  const responses = await Promise.all([
    post(customer + "/debits", "one").send({ amount: 75 }),
    post(customer + "/debits", "two").send({ amount: 75 }),
  ]);
  expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
  const failed = responses.findIndex(({ status }) => status === 409);
  expect(responses[failed].body).toEqual({ error: "insufficient_balance" });
  await get(customer)
    .expect(200)
    .expect(({ body }) => expect(body.balance).toBe(25));
  await post(customer + "/credits", "top-up")
    .send({ amount: 50 })
    .expect(201);
  await post(customer + "/debits", ["one", "two"][failed])
    .send({ amount: 75 })
    .expect(201);
  await get(customer)
    .expect(200)
    .expect(({ body }) => expect(body.balance).toBe(0));
});

it("coalesces same-key requests and rolls back a balance update if ledger insertion fails", async () => {
  const customer = await register();
  const [a, b] = await Promise.all([
    post(customer + "/credits", "same")
      .send({ amount: 400 })
      .expect(201),
    post(customer + "/credits", "same")
      .send({ amount: 400 })
      .expect(201),
  ]);
  expect(a.body).toEqual(b.body);
  await client.exec(
    "ALTER TABLE transactions ADD CONSTRAINT test_movement_failure CHECK (amount <> -27)",
  );
  try {
    await post(customer + "/debits", "rollback")
      .send({ amount: 27 })
      .expect(500);
    await get(customer)
      .expect(200)
      .expect(({ body }) => expect(body.balance).toBe(10400));
    expect(await db.select().from(transactions)).toHaveLength(2);
    expect(await db.select().from(idempotencyRequests)).toHaveLength(2);
  } finally {
    await client.exec(
      "ALTER TABLE transactions DROP CONSTRAINT test_movement_failure",
    );
  }
  await post(customer + "/debits", "rollback")
    .send({ amount: 27 })
    .expect(201);
});

it("validates amount, key and active customer while preserving history for deleted customers", async () => {
  await api.get(root + "/summary").expect(401);
  const customer = await register(2_147_483_647);
  await post(customer + "/credits", "overflow")
    .send({ amount: 1 })
    .expect(409, { error: "balance_limit" });
  await post(customer + "/debits", "zero")
    .send({ amount: 0 })
    .expect(400);
  await api
    .post(customer + "/credits")
    .auth("admin", { type: "bearer" })
    .send({ amount: 1 })
    .expect(400);
  await client.exec("UPDATE customers SET deleted_at = now()");
  await post(customer + "/debits", "deleted")
    .send({ amount: 1 })
    .expect(404);
  await get(customer + "/transactions")
    .expect(200)
    .expect(({ body }) => expect(body.transactions).toHaveLength(1));
  await get(root + "/summary").expect(200, {
    totalBalance: "0",
    customerCount: "0",
    totalUsed: "0",
  });
  expect((await db.select().from(customers))[0].balance).toBe(2_147_483_647);
});

it("reverses a debit once, records memo and links both ledger entries", async () => {
  const customer = await register();
  const debit = await post(customer + "/debits", "purchase")
    .send({ amount: 3000, memo: "  커피  " })
    .expect(201);
  const path =
    customer + "/transactions/" + debit.body.transaction.id + "/reversal";
  const result = await post(path, "cancel").send({ memo: "정정" }).expect(201);
  expect(result.body.transaction).toMatchObject({
    kind: "reversal",
    amount: 3000,
    balanceAfter: 10000,
    reversesId: debit.body.transaction.id,
  });
  await post(path, "cancel").send({ memo: "정정" }).expect(201, result.body);
  await post(path, "different")
    .send({})
    .expect(409, { error: "transaction_not_reversible" });
  await post(path, "cancel")
    .send({ memo: "다른 메모" })
    .expect(409, { error: "idempotency_key_conflict" });
  await get(customer + "/transactions")
    .expect(200)
    .expect(({ body }) => {
      expect(body.transactions).toEqual([
        expect.objectContaining({
          memo: "정정",
          reversesId: debit.body.transaction.id,
        }),
        expect.objectContaining({
          memo: "커피",
          reversedById: result.body.transaction.id,
        }),
        expect.objectContaining({ memo: null }),
      ]);
    });
  await get(root + "/summary").expect(200, {
    totalBalance: "10000",
    customerCount: "1",
    totalUsed: "0",
  });
});

it("blocks credit reversals when the resulting balance would be negative", async () => {
  const customer = await register();
  const credit = await post(customer + "/credits", "top-up")
    .send({ amount: 3000 })
    .expect(201);
  await post(customer + "/debits", "purchase")
    .send({ amount: 12000 })
    .expect(201);
  await post(
    customer + "/transactions/" + credit.body.transaction.id + "/reversal",
    "cancel",
  )
    .send({})
    .expect(409, { error: "insufficient_balance" });
  expect(await db.select().from(transactions)).toHaveLength(3);
});

it("renames and soft deletes individual, selected and all customers", async () => {
  const customer = await register();
  const second = await post(root, "second")
    .send({ name: "둘", initialAmount: 2000 })
    .expect(201);
  await api
    .patch(customer)
    .auth("admin", { type: "bearer" })
    .send({ name: "변경" })
    .expect(200)
    .expect(({ body }) => expect(body.name).toBe("변경"));
  await api
    .delete(customer)
    .auth("admin", { type: "bearer" })
    .expect(200, { deletedCount: 1 });
  await post(root + "/bulk-delete", "bulk")
    .send({ customerIds: [second.body.customer.id, second.body.customer.id] })
    .expect(200, { deletedCount: 1 });
  await get(customer + "/transactions")
    .expect(200)
    .expect(({ body }) => expect(body.transactions).toHaveLength(1));
  await post(root, "third")
    .send({ name: "셋", initialAmount: 1000 })
    .expect(201);
  const deletion = {
    confirmation: "전체 삭제",
    expectedCount: 1,
    pin: "123456",
  };
  await post(root + "/delete-all", "all")
    .send({ ...deletion, confirmation: "wrong" })
    .expect(400);
  await post(root + "/delete-all", "all")
    .send({ ...deletion, pin: "654321" })
    .expect(403, { error: "reauthentication_failed" });
  await post(root + "/delete-all", "all")
    .send({ ...deletion, expectedCount: 2 })
    .expect(409, { error: "customer_count_changed" });
  await post(root + "/delete-all", "all")
    .send(deletion)
    .expect(200, { deletedCount: 1 });
  await get(root).expect(200, { customers: [] });
  expect(
    (await db.select().from(customers))
      .map(({ balance }) => balance)
      .sort((a, b) => a - b),
  ).toEqual([1000, 2000, 10000]);
  expect(await db.select().from(transactions)).toHaveLength(3);
});
