CREATE TABLE `network_devices` (
	`mac` text PRIMARY KEY NOT NULL,
	`ip` text,
	`hostname` text,
	`vendor` text,
	`online` integer DEFAULT false NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`alias` text
);
--> statement-breakpoint
CREATE INDEX `network_devices_last_seen_idx` ON `network_devices` (`last_seen_at`);