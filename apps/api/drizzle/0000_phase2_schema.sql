CREATE TYPE "public"."transaction_kind" AS ENUM('credit', 'debit', 'reversal');--> statement-breakpoint
CREATE TABLE "admins" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "customers_balance_nonnegative" CHECK ("customers"."balance" >= 0)
);
--> statement-breakpoint
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"kind" "transaction_kind" NOT NULL,
	"amount" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"reverses_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_actor_idempotency_key" UNIQUE("actor_id","idempotency_key"),
	CONSTRAINT "transactions_customer_id_and_id" UNIQUE("customer_id","id"),
	CONSTRAINT "transactions_single_reversal" UNIQUE("reverses_id"),
	CONSTRAINT "transactions_kind_amount_and_reversal" CHECK (
    ("transactions"."kind" = 'credit' AND "transactions"."amount" > 0 AND "transactions"."reverses_id" IS NULL)
    OR ("transactions"."kind" = 'debit' AND "transactions"."amount" < 0 AND "transactions"."reverses_id" IS NULL)
    OR ("transactions"."kind" = 'reversal' AND "transactions"."amount" <> 0
      AND "transactions"."reverses_id" IS NOT NULL AND "transactions"."reverses_id" <> "transactions"."id")
  )
);
--> statement-breakpoint
ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_customer_id_reverses_id_transactions_customer_id_id_fk" FOREIGN KEY ("customer_id","reverses_id") REFERENCES "public"."transactions"("customer_id","id") ON DELETE no action ON UPDATE no action;