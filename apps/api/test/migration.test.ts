import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, it } from "vitest";
import { admins, customers, transactions } from "../src/db/schema.js";

it("applies the migration and enforces ledger constraints", async () => {
  const client = new PGlite();
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: "./drizzle" });
    await migrate(db, { migrationsFolder: "./drizzle" });

    const actorId = "13e93656-3dcd-4ba8-9709-3f4f082d0565";
    await db.insert(admins).values({ userId: actorId });
    expect(await db.select({ userId: admins.userId }).from(admins)).toEqual([
      { userId: actorId },
    ]);
    const [customer, otherCustomer] = await db
      .insert(customers)
      .values([{ name: "Test customer" }, { name: "Other customer" }])
      .returning();
    expect(customer.balance).toBe(0);
    await expect(
      db.insert(customers).values({ name: "Invalid", balance: -1 }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    const credit = {
      customerId: customer.id,
      actorId,
      kind: "credit",
      amount: 3000,
      idempotencyKey: "credit-1",
    } as const;
    const [original] = await db.insert(transactions).values(credit).returning();
    await expect(db.insert(transactions).values(credit)).rejects.toMatchObject({
      cause: { code: "23505" },
    });

    const reversal = {
      customerId: customer.id,
      actorId,
      kind: "reversal",
      amount: -3000,
      idempotencyKey: "reverse-1",
      reversesId: original.id,
    } as const;
    await expect(
      db
        .insert(transactions)
        .values({ ...reversal, customerId: otherCustomer.id }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
    await db.insert(transactions).values(reversal);
    await expect(
      db
        .insert(transactions)
        .values({ ...reversal, idempotencyKey: "reverse-2" }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  } finally {
    await client.close();
  }
});

it("preserves Phase 2 ledger rows when adding registration storage", async () => {
  const client = new PGlite();
  try {
    const db = drizzle(client);
    await client.exec(
      await readFile("./drizzle/0000_phase2_schema.sql", "utf8"),
    );
    const [customer] = await db
      .insert(customers)
      .values({ name: "Existing", balance: 1200 })
      .returning();
    await client.query(
      "INSERT INTO transactions (customer_id, actor_id, kind, amount, idempotency_key) VALUES ($1, $2, 'credit', 1200, 'existing')",
      [customer.id, "13e93656-3dcd-4ba8-9709-3f4f082d0565"],
    );
    await client.exec(
      await readFile("./drizzle/0001_phase3_registration.sql", "utf8"),
    );
    await client.exec(
      await readFile("./drizzle/0002_transaction_memo.sql", "utf8"),
    );
    expect(await db.select().from(customers)).toEqual([customer]);
    expect(await db.select().from(transactions)).toEqual([
      expect.objectContaining({
        customerId: customer.id,
        amount: 1200,
        idempotencyKey: "existing",
        balanceAfter: null,
        memo: null,
      }),
    ]);
  } finally {
    await client.close();
  }
});
