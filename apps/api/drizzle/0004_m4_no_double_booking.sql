-- No double booking, enforced by Postgres: two active appointments on the same resource
-- can never hold overlapping time ranges (concurrent bookings: one wins, the other gets 23P01).
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_overlap"
  EXCLUDE USING gist ("tenant_id" WITH =, "resource" WITH =, tstzrange("starts_at", "busy_until") WITH &&)
  WHERE ("status" IN ('pending', 'scheduled', 'confirmed'));--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_valid_range" CHECK ("starts_at" < "ends_at" AND "ends_at" <= "busy_until");--> statement-breakpoint
CREATE INDEX "appointments_tenant_starts" ON "appointments" ("tenant_id", "starts_at");
--> statement-breakpoint
-- Tenants created before booking existed: start their bookable hours from their business hours.
INSERT INTO "availability_rules" ("tenant_id", "weekday", "start_time", "end_time", "resource")
SELECT c."tenant_id", d.day, h->>'open', h->>'close', 'default'
FROM (
  SELECT DISTINCT ON ("tenant_id") "tenant_id", "config" FROM "tenant_configs" ORDER BY "tenant_id", "revision" DESC
) c
CROSS JOIN LATERAL jsonb_array_elements(c."config"->'locale'->'business_hours') h
CROSS JOIN LATERAL jsonb_array_elements_text(h->'days') AS d(day)
WHERE NOT EXISTS (SELECT 1 FROM "availability_rules" r WHERE r."tenant_id" = c."tenant_id");
