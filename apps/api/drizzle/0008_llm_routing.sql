ALTER TABLE "llm_runs" ADD COLUMN "task" text DEFAULT 'agent_reply' NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_runs" ADD COLUMN "prompt_version" text;--> statement-breakpoint
ALTER TABLE "llm_runs" ADD COLUMN "fallback_used" boolean DEFAULT false NOT NULL;