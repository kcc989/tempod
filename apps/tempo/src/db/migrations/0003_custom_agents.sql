CREATE TABLE `custom_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`base_agent` text NOT NULL,
	`repo` text NOT NULL,
	`path` text NOT NULL,
	`commit_sha` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "custom_agents_base_agent" CHECK("custom_agents"."base_agent" IN ('claude','codex','opencode','pi'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_agents_active_name` ON `custom_agents` (`user_id`,`name`) WHERE deleted_at IS NULL;