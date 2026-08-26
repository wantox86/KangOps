CREATE TABLE `containers` (
	`docker_id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`current_name` text NOT NULL,
	`image_ref` text NOT NULL,
	`image_digest` text,
	`compose_project` text,
	`compose_service` text,
	`current_state` text NOT NULL,
	`current_health` text NOT NULL,
	`restart_count` integer DEFAULT 0 NOT NULL,
	`critical` integer DEFAULT false NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`host_id` text NOT NULL,
	`container_id` text,
	`occurred_at` text NOT NULL,
	`source` text NOT NULL,
	`type` text NOT NULL,
	`severity` text NOT NULL,
	`summary` text NOT NULL,
	`metadata_json` text,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`container_id`) REFERENCES `containers`(`docker_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `containers_host_id_idx` ON `containers` (`host_id`);--> statement-breakpoint
CREATE INDEX `events_host_id_occurred_at_idx` ON `events` (`host_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `events_container_id_occurred_at_idx` ON `events` (`container_id`,`occurred_at`);