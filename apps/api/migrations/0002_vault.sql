DROP TABLE `documents`;--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`asset_id` text,
	`meta` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`storage_path` text NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "documents_meta_check" CHECK(json_extract("documents"."meta", '$.ct') is not null),
	CONSTRAINT "documents_size_check" CHECK("documents"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE INDEX `documents_owner_idx` ON `documents` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `documents_asset_idx` ON `documents` (`asset_id`);--> statement-breakpoint
CREATE TABLE `vault_keys` (
	`user_id` text PRIMARY KEY NOT NULL,
	`kdf_salt` text NOT NULL,
	`kdf_params` text NOT NULL,
	`wrapped_dek` text NOT NULL,
	`public_key_jwk` text NOT NULL,
	`wrapped_private_key` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vault_keys_dek_check" CHECK(json_extract("vault_keys"."wrapped_dek", '$.ct') is not null),
	CONSTRAINT "vault_keys_private_check" CHECK(json_extract("vault_keys"."wrapped_private_key", '$.ct') is not null)
);
--> statement-breakpoint
CREATE TABLE `vault_items` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`asset_id` text,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "vault_items_kind_check" CHECK("vault_items"."kind" in ('bank_login', 'card', 'demat', 'policy', 'locker', 'credential', 'document_location', 'instruction', 'note')),
	CONSTRAINT "vault_items_payload_check" CHECK(json_extract("vault_items"."payload", '$.ct') is not null)
);
--> statement-breakpoint
CREATE INDEX `vault_items_owner_idx` ON `vault_items` (`owner_user_id`,`kind`);--> statement-breakpoint
CREATE INDEX `vault_items_asset_idx` ON `vault_items` (`asset_id`);--> statement-breakpoint
CREATE TABLE `vault_escrow` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`nominee_id` text NOT NULL,
	`grantee_user_id` text NOT NULL,
	`wrapped_dek` text NOT NULL,
	`public_key_fingerprint` text NOT NULL,
	`state` text DEFAULT 'sealed' NOT NULL,
	`release_reason` text,
	`released_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nominee_id`) REFERENCES `nominees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grantee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vault_escrow_state_check" CHECK("vault_escrow"."state" in ('sealed', 'released', 'revoked')),
	CONSTRAINT "vault_escrow_reason_check" CHECK("vault_escrow"."release_reason" is null or "vault_escrow"."release_reason" in ('owner', 'deadman')),
	CONSTRAINT "vault_escrow_released_check" CHECK(("vault_escrow"."state" <> 'released') or ("vault_escrow"."released_at" is not null and "vault_escrow"."release_reason" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_escrow_nominee_unique` ON `vault_escrow` (`nominee_id`);--> statement-breakpoint
CREATE INDEX `vault_escrow_owner_idx` ON `vault_escrow` (`owner_user_id`,`state`);--> statement-breakpoint
CREATE INDEX `vault_escrow_grantee_idx` ON `vault_escrow` (`grantee_user_id`,`state`);--> statement-breakpoint
CREATE TABLE `dead_man_switch` (
	`user_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`inactivity_days` integer DEFAULT 90 NOT NULL,
	`grace_days` integer DEFAULT 7 NOT NULL,
	`last_checkin_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`stage` text DEFAULT 'idle' NOT NULL,
	`grace_started_at` text,
	`fired_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "dead_man_switch_stage_check" CHECK("dead_man_switch"."stage" in ('idle', 'warned_50', 'warned_75', 'warned_90', 'grace', 'fired')),
	CONSTRAINT "dead_man_switch_inactivity_check" CHECK("dead_man_switch"."inactivity_days" between 30 and 730),
	CONSTRAINT "dead_man_switch_grace_check" CHECK("dead_man_switch"."grace_days" between 1 and 90 and "dead_man_switch"."grace_days" < "dead_man_switch"."inactivity_days")
);
--> statement-breakpoint
CREATE INDEX `dead_man_switch_enabled_idx` ON `dead_man_switch` (`enabled`,`stage`);
