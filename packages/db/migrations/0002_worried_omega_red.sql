CREATE TABLE `strava_cache` (
	`athlete_id` integer NOT NULL,
	`cache_key` text NOT NULL,
	`data` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`athlete_id`, `cache_key`)
);
