CREATE TABLE `deadman_checkins` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`stage` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deadman_checkins_token_hash_unique` ON `deadman_checkins` (`token_hash`);--> statement-breakpoint
CREATE INDEX `deadman_checkins_user_idx` ON `deadman_checkins` (`user_id`,`created_at`);
