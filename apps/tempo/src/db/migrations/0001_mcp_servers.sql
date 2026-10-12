CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`command` text,
	`args_json` text DEFAULT '[]' NOT NULL,
	`env_json` text DEFAULT '[]' NOT NULL,
	`url` text,
	`headers_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mcp_servers_transport" CHECK("mcp_servers"."transport" IN ('stdio','http','sse'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_user_name` ON `mcp_servers` (`user_id`,`name`);