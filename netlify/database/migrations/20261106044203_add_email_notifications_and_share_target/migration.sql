ALTER TABLE "residents" ADD COLUMN "token_warning_sent_for" text;--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "target" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "target_category" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "purpose" text DEFAULT '' NOT NULL;