CREATE TABLE "mcp_tool_grant" (
	"session_key" text NOT NULL,
	"tool" text NOT NULL,
	"created_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	CONSTRAINT "mcp_tool_grant_session_key_tool_pk" PRIMARY KEY("session_key","tool")
);
--> statement-breakpoint
CREATE INDEX "mcp_tool_grant_created_at_idx" ON "mcp_tool_grant" USING btree ("created_at");