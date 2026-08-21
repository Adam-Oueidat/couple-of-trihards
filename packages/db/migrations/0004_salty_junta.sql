CREATE TABLE `training_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`discipline` text NOT NULL,
	`start_date` text NOT NULL,
	`race_date` text NOT NULL,
	`race_name` text NOT NULL,
	`sessions` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `training_plans_user_created_idx` ON `training_plans` (`user_id`,`created_at`);