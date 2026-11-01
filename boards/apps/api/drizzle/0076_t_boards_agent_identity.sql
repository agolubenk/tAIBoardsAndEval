CREATE TABLE "agent_profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"harness" text NOT NULL,
	"session" text NOT NULL,
	"disabled_at" timestamp,
	"last_issued_at" timestamp,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_profile" ADD CONSTRAINT "agent_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "agent_profile" ADD CONSTRAINT "agent_profile_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "agent_profile_owner_idx" ON "agent_profile" USING btree ("owner_id");