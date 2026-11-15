CREATE TABLE "activities" (
	"id" serial PRIMARY KEY,
	"nik" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"type" text DEFAULT 'info' NOT NULL,
	"icon" text DEFAULT 'ph-info' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "helpdesk_messages" (
	"id" serial PRIMARY KEY,
	"ticket_id" integer NOT NULL,
	"sender" text NOT NULL,
	"sender_name" text NOT NULL,
	"sender_id" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "helpdesk_tickets" (
	"id" serial PRIMARY KEY,
	"nik" text NOT NULL,
	"subject" text NOT NULL,
	"category" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"last_sender" text DEFAULT 'user' NOT NULL,
	"user_last_read_at" bigint DEFAULT 0 NOT NULL,
	"admin_last_read_at" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "history" (
	"id" serial PRIMARY KEY,
	"nik" text NOT NULL,
	"entity" text NOT NULL,
	"action" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'Berhasil' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_failures" (
	"id" serial PRIMARY KEY,
	"nik" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "residents" (
	"nik" text PRIMARY KEY,
	"name" text NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"token" text DEFAULT 'BELUM_GENERATE' NOT NULL,
	"token_expires_at" bigint,
	"documents" jsonb DEFAULT '[]' NOT NULL,
	"profile" jsonb DEFAULT '{}' NOT NULL,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"password_hash" text,
	"password_updated_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" text PRIMARY KEY,
	"owner_nik" text NOT NULL,
	"document_id" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "activities_nik_idx" ON "activities" ("nik","created_at");--> statement-breakpoint
CREATE INDEX "helpdesk_messages_ticket_idx" ON "helpdesk_messages" ("ticket_id");--> statement-breakpoint
CREATE INDEX "helpdesk_tickets_nik_idx" ON "helpdesk_tickets" ("nik");--> statement-breakpoint
CREATE INDEX "history_nik_idx" ON "history" ("nik","created_at");--> statement-breakpoint
CREATE INDEX "login_failures_nik_idx" ON "login_failures" ("nik","created_at");--> statement-breakpoint
ALTER TABLE "helpdesk_messages" ADD CONSTRAINT "helpdesk_messages_ticket_id_helpdesk_tickets_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "helpdesk_tickets"("id") ON DELETE CASCADE;