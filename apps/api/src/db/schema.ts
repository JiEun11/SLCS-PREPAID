import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  primaryKey,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const admins = pgTable("admins", {
  userId: uuid("user_id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
}).enableRLS();

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    balance: integer("balance").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    check("customers_balance_nonnegative", sql`${table.balance} >= 0`),
  ],
).enableRLS();

export const transactionKind = pgEnum("transaction_kind", [
  "credit",
  "debit",
  "reversal",
]);

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    actorId: uuid("actor_id").notNull(),
    kind: transactionKind("kind").notNull(),
    amount: integer("amount").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    balanceAfter: integer("balance_after"),
    reversesId: uuid("reverses_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "transactions_balance_after_nonnegative",
      sql`${table.balanceAfter} >= 0`,
    ),
    unique("transactions_actor_idempotency_key").on(
      table.actorId,
      table.idempotencyKey,
    ),
    unique("transactions_customer_id_and_id").on(table.customerId, table.id),
    unique("transactions_single_reversal").on(table.reversesId),
    foreignKey({
      columns: [table.customerId, table.reversesId],
      foreignColumns: [table.customerId, table.id],
    }),
    check(
      "transactions_kind_amount_and_reversal",
      sql`
    (${table.kind} = 'credit' AND ${table.amount} > 0 AND ${table.reversesId} IS NULL)
    OR (${table.kind} = 'debit' AND ${table.amount} < 0 AND ${table.reversesId} IS NULL)
    OR (${table.kind} = 'reversal' AND ${table.amount} <> 0
      AND ${table.reversesId} IS NOT NULL AND ${table.reversesId} <> ${table.id})
  `,
    ),
  ],
).enableRLS();

export const idempotencyRequests = pgTable(
  "idempotency_requests",
  {
    actorId: uuid("actor_id").notNull(),
    key: text("key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.actorId, table.key] })],
).enableRLS();
