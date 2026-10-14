CREATE TABLE `agent_migrations` (
	`user_id` text PRIMARY KEY NOT NULL,
	`migrated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`definition_json` text NOT NULL,
	`version` integer NOT NULL,
	`sha` text NOT NULL,
	`starter` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_active_handle` ON `agents` (`user_id`,`handle`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_active_name` ON `agents` (`user_id`,`name`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE TABLE `project_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`hooks_json` text DEFAULT '[]' NOT NULL,
	`auto_send` integer DEFAULT 0 NOT NULL,
	`max_runs` integer DEFAULT 3 NOT NULL,
	`timeout` text DEFAULT '20m' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_agents_project_agent` ON `project_agents` (`project_id`,`agent_id`);