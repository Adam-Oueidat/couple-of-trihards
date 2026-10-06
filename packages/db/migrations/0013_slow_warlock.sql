ALTER TABLE `plan_drafts` ADD `parent_id` text;--> statement-breakpoint
ALTER TABLE `plan_drafts` ADD `feedback` text;--> statement-breakpoint
ALTER TABLE `plan_drafts` ADD `insist` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `plan_drafts` ADD `revision` integer DEFAULT 0 NOT NULL;