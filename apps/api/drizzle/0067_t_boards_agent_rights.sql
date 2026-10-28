ALTER TABLE "owner_approval" ADD COLUMN "params" jsonb;--> statement-breakpoint
CREATE INDEX "agent_journal_target_idx" ON "agent_journal" USING btree ("target_type","target_id");