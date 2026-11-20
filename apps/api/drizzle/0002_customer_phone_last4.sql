ALTER TABLE "customers" ADD COLUMN "phone_last4" text;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_phone_last4_format" CHECK ("customers"."phone_last4" ~ '^[0-9]{4}$');