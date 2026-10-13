CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`egress_policy` text DEFAULT 'allowlist' NOT NULL,
	`egress_allowlist_json` text DEFAULT '[]' NOT NULL,
	`secrets_json` text DEFAULT '[]' NOT NULL,
	`injectors_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "environments_egress_policy" CHECK("environments"."egress_policy" IN ('open','allowlist'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environments_user_name` ON `environments` (`user_id`,`name`);--> statement-breakpoint
ALTER TABLE `projects` ADD `environment_id` text REFERENCES environments(id) ON DELETE SET NULL;