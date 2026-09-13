CREATE TABLE `agents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`host_id` text NOT NULL,
	`token` text NOT NULL,
	`expected_interval_seconds` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`agent_version` text,
	`last_report_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_token_idx` ON `agents` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `agents_host_id_idx` ON `agents` (`host_id`);