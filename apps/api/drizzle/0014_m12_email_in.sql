ALTER TABLE "tenants" ADD COLUMN "email_in_key" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_emailInKey_unique" UNIQUE("email_in_key");