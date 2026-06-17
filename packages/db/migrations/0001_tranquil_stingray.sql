ALTER TABLE `licenses` ADD `expires_at` integer;--> statement-breakpoint
CREATE INDEX `licenses_expires_at_idx` ON `licenses` (`expires_at`);