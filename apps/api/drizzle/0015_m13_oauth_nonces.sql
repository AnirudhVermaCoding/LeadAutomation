CREATE TABLE "oauth_nonces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"nonce" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_nonces_tenantId_nonce_unique" UNIQUE("tenant_id","nonce")
);
--> statement-breakpoint
ALTER TABLE "oauth_nonces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_nonces" ADD CONSTRAINT "oauth_nonces_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "oauth_nonces" AS PERMISSIVE FOR ALL TO "instantlead_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);