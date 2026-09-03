ALTER TABLE `plan_overrides` ADD `skipped` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `plan_overrides` ADD `skip_reason` text;