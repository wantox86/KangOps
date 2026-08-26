CREATE TABLE `health_conditions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`code` text NOT NULL,
	`severity` text NOT NULL,
	`penalty` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`summary` text NOT NULL,
	`detected_at` text NOT NULL,
	`resolved_at` text,
	`evidence_json` text
);
--> statement-breakpoint
CREATE TABLE `metric_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`host_id` text NOT NULL,
	`container_id` text,
	`observed_at` text NOT NULL,
	`cpu_percent` real,
	`memory_bytes` integer,
	`memory_limit_bytes` integer,
	`disk_used_bytes` integer,
	`disk_total_bytes` integer,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`container_id`) REFERENCES `containers`(`docker_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `metric_samples_hourly` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`host_id` text NOT NULL,
	`container_id` text,
	`bucket_start` text NOT NULL,
	`sample_count` integer NOT NULL,
	`avg_cpu_percent` real,
	`max_cpu_percent` real,
	`avg_memory_bytes` integer,
	`max_memory_bytes` integer,
	`memory_limit_bytes` integer,
	`avg_disk_used_bytes` integer,
	`disk_total_bytes` integer,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`container_id`) REFERENCES `containers`(`docker_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `health_conditions_entity_idx` ON `health_conditions` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `health_conditions_active_idx` ON `health_conditions` (`active`,`detected_at`);--> statement-breakpoint
CREATE INDEX `metric_samples_host_observed_idx` ON `metric_samples` (`host_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `metric_samples_container_observed_idx` ON `metric_samples` (`container_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `metric_samples_hourly_host_bucket_idx` ON `metric_samples_hourly` (`host_id`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `metric_samples_hourly_container_bucket_idx` ON `metric_samples_hourly` (`container_id`,`bucket_start`);