CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`code` text NOT NULL,
	`severity` text NOT NULL,
	`destination` text NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`sent_at` text NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `backup_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target_id` integer NOT NULL,
	`occurred_at` text NOT NULL,
	`status` text NOT NULL,
	`message` text,
	`source` text NOT NULL,
	FOREIGN KEY (`target_id`) REFERENCES `backup_targets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `backup_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`expected_frequency_minutes` integer NOT NULL,
	`check_path` text,
	`token` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dependency_annotations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_container_id` text NOT NULL,
	`to_container_id` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`from_container_id`) REFERENCES `containers`(`docker_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_container_id`) REFERENCES `containers`(`docker_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `image_metadata` (
	`image_ref` text PRIMARY KEY NOT NULL,
	`registry_supported` integer NOT NULL,
	`latest_digest` text,
	`update_available` integer,
	`last_checked_at` text,
	`check_error` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alerts_dedupe_key_sent_at_idx` ON `alerts` (`dedupe_key`,`sent_at`);--> statement-breakpoint
CREATE INDEX `backup_runs_target_occurred_idx` ON `backup_runs` (`target_id`,`occurred_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `backup_targets_token_idx` ON `backup_targets` (`token`);--> statement-breakpoint
CREATE INDEX `dependency_annotations_from_idx` ON `dependency_annotations` (`from_container_id`);--> statement-breakpoint
CREATE INDEX `dependency_annotations_to_idx` ON `dependency_annotations` (`to_container_id`);