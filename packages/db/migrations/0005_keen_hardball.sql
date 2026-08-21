CREATE TABLE `pb_sync_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`synced_through` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
