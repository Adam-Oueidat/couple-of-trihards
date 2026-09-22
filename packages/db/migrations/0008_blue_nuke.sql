CREATE TABLE `activity_quality` (
	`user_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`start_date` text NOT NULL,
	`started_at` integer NOT NULL,
	`name` text NOT NULL,
	`workout_key` text NOT NULL,
	`moving_time` integer NOT NULL,
	`elapsed_time` integer NOT NULL,
	`distance` real NOT NULL,
	`avg_hr` integer,
	`max_hr` integer,
	`hr_seconds` text,
	`hr_coverage` real,
	`decoupling` real,
	`decoupling_eligible` integer DEFAULT false NOT NULL,
	`structure_kind` text,
	`sets` text,
	`work_seconds` integer,
	`recovery_seconds` integer,
	`stream_status` text NOT NULL,
	`lap_status` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`schema_version` integer NOT NULL,
	`derived_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `activity_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `activity_quality_user_started_idx` ON `activity_quality` (`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `activity_quality_user_workout_idx` ON `activity_quality` (`user_id`,`workout_key`);--> statement-breakpoint
CREATE TABLE `scan_state` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`last_run_at` integer NOT NULL,
	`last_result` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `kind`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
