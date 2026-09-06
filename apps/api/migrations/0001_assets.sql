CREATE TABLE `access_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`grantee_user_id` text NOT NULL,
	`scope` text DEFAULT 'summary' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_id` text,
	`granted_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grantee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "access_grants_scope_check" CHECK("access_grants"."scope" in ('summary', 'full', 'vault')),
	CONSTRAINT "access_grants_source_check" CHECK("access_grants"."source" in ('household', 'nominee', 'manual'))
);
--> statement-breakpoint
CREATE INDEX `access_grants_grantee_idx` ON `access_grants` (`grantee_user_id`,`scope`);--> statement-breakpoint
CREATE INDEX `access_grants_owner_idx` ON `access_grants` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`institution` text,
	`nominee_registered` integer DEFAULT false NOT NULL,
	`ownership_bps` integer DEFAULT 10000 NOT NULL,
	`joint_with` text,
	`status` text DEFAULT 'active' NOT NULL,
	`opened_on` text,
	`closed_on` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assets_type_check" CHECK("assets"."type" in ('bank_account', 'deposit', 'holding', 'insurance_policy', 'property', 'retirement_account', 'precious_metal', 'other_asset', 'liability')),
	CONSTRAINT "assets_status_check" CHECK("assets"."status" in ('active', 'closed', 'archived')),
	CONSTRAINT "assets_ownership_check" CHECK("assets"."ownership_bps" between 0 and 10000)
);
--> statement-breakpoint
CREATE INDEX `assets_owner_idx` ON `assets` (`owner_user_id`,`status`,`type`);--> statement-breakpoint
CREATE INDEX `assets_nomination_idx` ON `assets` (`owner_user_id`,`nominee_registered`);--> statement-breakpoint
CREATE TABLE `bank_accounts` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`account_number_masked` text,
	`ifsc` text,
	`branch` text,
	`cif` text,
	`account_type` text DEFAULT 'savings' NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "bank_accounts_type_check" CHECK("bank_accounts"."account_type" in ('savings', 'current', 'salary', 'nre', 'nro', 'fcnr'))
);
--> statement-breakpoint
CREATE TABLE `deposits` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`account_number_masked` text,
	`principal_paise` integer DEFAULT 0 NOT NULL,
	`installment_paise` integer DEFAULT 0 NOT NULL,
	`rate_bps` integer DEFAULT 0 NOT NULL,
	`compounding` text DEFAULT 'quarterly' NOT NULL,
	`payout_mode` text DEFAULT 'cumulative' NOT NULL,
	`started_on` text NOT NULL,
	`matures_on` text,
	`auto_renew` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "deposits_kind_check" CHECK("deposits"."kind" in ('fd', 'rd', 'ppf', 'ssy', 'nsc', 'kvp', 'mis', 'scss')),
	CONSTRAINT "deposits_compounding_check" CHECK("deposits"."compounding" in ('monthly', 'quarterly', 'half_yearly', 'yearly', 'maturity', 'simple')),
	CONSTRAINT "deposits_payout_check" CHECK("deposits"."payout_mode" in ('cumulative', 'monthly', 'quarterly', 'half_yearly', 'yearly'))
);
--> statement-breakpoint
CREATE INDEX `deposits_matures_idx` ON `deposits` (`matures_on`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`asset_id` text,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`storage_path` text NOT NULL,
	`sha256` text NOT NULL,
	`encrypted` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `documents_owner_idx` ON `documents` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `documents_asset_idx` ON `documents` (`asset_id`);--> statement-breakpoint
CREATE TABLE `holdings` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`instrument_id` text NOT NULL,
	`units` integer DEFAULT 0 NOT NULL,
	`avg_cost_micro` integer DEFAULT 0 NOT NULL,
	`folio_number_masked` text,
	`sip_amount_paise` integer,
	`sip_day` integer,
	`demat_account_masked` text,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "holdings_sip_day_check" CHECK("holdings"."sip_day" is null or "holdings"."sip_day" between 1 and 28)
);
--> statement-breakpoint
CREATE INDEX `holdings_instrument_idx` ON `holdings` (`instrument_id`);--> statement-breakpoint
CREATE TABLE `household_members` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`share_mode` text DEFAULT 'none' NOT NULL,
	`consented_at` text,
	`accepted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "household_members_role_check" CHECK("household_members"."role" in ('owner', 'partner', 'member')),
	CONSTRAINT "household_members_share_mode_check" CHECK("household_members"."share_mode" in ('full', 'summary', 'none'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `household_members_unique` ON `household_members` (`household_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `household_members_user_idx` ON `household_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `households` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_by_user_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `instrument_prices` (
	`instrument_id` text NOT NULL,
	`date` text NOT NULL,
	`price_micro` integer NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`instrument_id`, `date`),
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "instrument_prices_source_check" CHECK("instrument_prices"."source" in ('manual', 'amfi', 'yahoo', 'computed'))
);
--> statement-breakpoint
CREATE INDEX `instrument_prices_lookup_idx` ON `instrument_prices` (`instrument_id`,`date`);--> statement-breakpoint
CREATE TABLE `instruments` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`amfi_scheme_code` text,
	`isin` text,
	`symbol` text,
	`exchange` text DEFAULT 'none' NOT NULL,
	`amc` text,
	`category` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "instruments_kind_check" CHECK("instruments"."kind" in ('mf', 'equity', 'etf', 'bond')),
	CONSTRAINT "instruments_exchange_check" CHECK("instruments"."exchange" in ('nse', 'bse', 'none'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instruments_amfi_idx` ON `instruments` (`amfi_scheme_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `instruments_isin_idx` ON `instruments` (`isin`);--> statement-breakpoint
CREATE INDEX `instruments_symbol_idx` ON `instruments` (`symbol`);--> statement-breakpoint
CREATE INDEX `instruments_name_idx` ON `instruments` (`name`);--> statement-breakpoint
CREATE TABLE `insurance_policies` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`policy_number_masked` text,
	`insurer` text NOT NULL,
	`plan` text,
	`kind` text NOT NULL,
	`sum_assured_paise` integer DEFAULT 0 NOT NULL,
	`premium_paise` integer DEFAULT 0 NOT NULL,
	`premium_frequency` text DEFAULT 'yearly' NOT NULL,
	`next_due_on` text,
	`started_on` text,
	`matures_on` text,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "insurance_kind_check" CHECK("insurance_policies"."kind" in ('term', 'endowment', 'ulip', 'money_back', 'health')),
	CONSTRAINT "insurance_frequency_check" CHECK("insurance_policies"."premium_frequency" in ('monthly', 'quarterly', 'half_yearly', 'yearly', 'single'))
);
--> statement-breakpoint
CREATE INDEX `insurance_due_idx` ON `insurance_policies` (`next_due_on`);--> statement-breakpoint
CREATE TABLE `liabilities` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`lender` text NOT NULL,
	`account_number_masked` text,
	`principal_paise` integer DEFAULT 0 NOT NULL,
	`outstanding_paise` integer DEFAULT 0 NOT NULL,
	`rate_bps` integer DEFAULT 0 NOT NULL,
	`emi_paise` integer DEFAULT 0 NOT NULL,
	`tenure_months` integer,
	`next_due_on` text,
	`started_on` text,
	`ends_on` text,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "liabilities_kind_check" CHECK("liabilities"."kind" in ('home', 'car', 'personal', 'education', 'gold', 'credit_card', 'loan_against', 'business'))
);
--> statement-breakpoint
CREATE INDEX `liabilities_due_idx` ON `liabilities` (`next_due_on`);--> statement-breakpoint
CREATE TABLE `nominees` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`nominee_user_id` text,
	`email` text,
	`name` text NOT NULL,
	`relation` text,
	`share_percent_bps` integer DEFAULT 0 NOT NULL,
	`access_level` text DEFAULT 'summary' NOT NULL,
	`status` text DEFAULT 'invited' NOT NULL,
	`invited_at` text,
	`accepted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nominee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "nominees_access_level_check" CHECK("nominees"."access_level" in ('summary', 'full', 'vault')),
	CONSTRAINT "nominees_status_check" CHECK("nominees"."status" in ('invited', 'accepted', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX `nominees_owner_idx` ON `nominees` (`owner_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `nominees_user_idx` ON `nominees` (`nominee_user_id`);--> statement-breakpoint
CREATE TABLE `other_assets` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "other_assets_kind_check" CHECK("other_assets"."kind" in ('crypto', 'esop', 'rsu', 'chit', 'loan_given', 'vehicle'))
);
--> statement-breakpoint
CREATE TABLE `precious_metals` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`form` text NOT NULL,
	`metal` text DEFAULT 'gold' NOT NULL,
	`weight_milligrams` integer DEFAULT 0 NOT NULL,
	`purity` text,
	`making_charges_paise` integer DEFAULT 0 NOT NULL,
	`sgb_matures_on` text,
	`sgb_interest_dates` text,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "precious_metals_form_check" CHECK("precious_metals"."form" in ('physical', 'digital', 'sgb', 'jewellery')),
	CONSTRAINT "precious_metals_metal_check" CHECK("precious_metals"."metal" in ('gold', 'silver', 'platinum'))
);
--> statement-breakpoint
CREATE TABLE `properties` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`address` text,
	`survey_number` text,
	`khata_number` text,
	`patta_number` text,
	`registration_doc_number` text,
	`sub_registrar_office` text,
	`area_micro` integer,
	`area_unit` text DEFAULT 'sqft' NOT NULL,
	`guideline_value_paise` integer,
	`co_owners` text,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "properties_kind_check" CHECK("properties"."kind" in ('land', 'plot', 'flat', 'house', 'commercial')),
	CONSTRAINT "properties_area_unit_check" CHECK("properties"."area_unit" in ('sqft', 'sqyd', 'sqm', 'acre', 'cent', 'guntha', 'hectare'))
);
--> statement-breakpoint
CREATE TABLE `retirement_accounts` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`uan_masked` text,
	`member_id_masked` text,
	`pran_masked` text,
	`tier` text,
	`scheme_mix` text,
	`employee_balance_paise` integer DEFAULT 0 NOT NULL,
	`employer_balance_paise` integer DEFAULT 0 NOT NULL,
	`rate_bps` integer,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "retirement_kind_check" CHECK("retirement_accounts"."kind" in ('epf', 'vpf', 'nps')),
	CONSTRAINT "retirement_tier_check" CHECK("retirement_accounts"."tier" is null or "retirement_accounts"."tier" in ('tier_1', 'tier_2'))
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`date` text NOT NULL,
	`type` text NOT NULL,
	`units` integer,
	`amount_paise` integer NOT NULL,
	`price_micro` integer,
	`charges_paise` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "transactions_type_check" CHECK("transactions"."type" in ('buy', 'sell', 'sip', 'dividend', 'interest', 'deposit', 'withdrawal', 'premium', 'emi'))
);
--> statement-breakpoint
CREATE INDEX `transactions_asset_date_idx` ON `transactions` (`asset_id`,`date`);--> statement-breakpoint
CREATE TABLE `valuations` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`as_of` text NOT NULL,
	`value_paise` integer NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "valuations_source_check" CHECK("valuations"."source" in ('manual', 'amfi', 'yahoo', 'computed'))
);
--> statement-breakpoint
CREATE INDEX `valuations_asset_idx` ON `valuations` (`asset_id`,`as_of`);