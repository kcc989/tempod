CREATE TABLE `project_members` (
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `user_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "project_members_role" CHECK("project_members"."role" IN ('read','write','admin'))
);
--> statement-breakpoint
CREATE INDEX `project_members_user` ON `project_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `project_stars` (
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `project_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_stars_project` ON `project_stars` (`project_id`);--> statement-breakpoint
CREATE TABLE `invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`inviter_id` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invitation_organizationId_idx` ON `invitation` (`organization_id`);--> statement-breakpoint
CREATE INDEX `invitation_email_idx` ON `invitation` (`email`);--> statement-breakpoint
CREATE TABLE `member` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_organizationId_idx` ON `member` (`organization_id`);--> statement-breakpoint
CREATE INDEX `member_userId_idx` ON `member` (`user_id`);--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`created_at` integer NOT NULL,
	`metadata` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_unique` ON `organization` (`slug`);--> statement-breakpoint
ALTER TABLE `projects` ADD `organization_id` text REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict;--> statement-breakpoint
ALTER TABLE `projects` ADD `slug` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `visibility` text DEFAULT 'private' NOT NULL CONSTRAINT "projects_visibility" CHECK("visibility" IN ('public','private'));--> statement-breakpoint
UPDATE `projects` SET `slug` = `repo_name`;--> statement-breakpoint
UPDATE `projects` SET `slug` = `repo_owner` || '-' || `repo_name`
WHERE EXISTS (
	SELECT 1 FROM `projects` AS `earlier`
	WHERE `earlier`.`user_id` = `projects`.`user_id`
		AND lower(`earlier`.`repo_name`) = lower(`projects`.`repo_name`)
		AND (`earlier`.`created_at` < `projects`.`created_at`
			OR (`earlier`.`created_at` = `projects`.`created_at` AND `earlier`.`id` < `projects`.`id`))
);--> statement-breakpoint
UPDATE `projects` SET `slug` = `slug` || '-' || `id`
WHERE EXISTS (
	SELECT 1 FROM `projects` AS `other`
	WHERE `other`.`user_id` = `projects`.`user_id`
		AND `other`.`id` <> `projects`.`id`
		AND lower(`other`.`slug`) = lower(`projects`.`slug`)
		AND (`other`.`created_at` < `projects`.`created_at`
			OR (`other`.`created_at` = `projects`.`created_at` AND `other`.`id` < `projects`.`id`))
);--> statement-breakpoint
DROP INDEX `projects_user_repo`;--> statement-breakpoint
DROP INDEX `projects_user_artifact_repo`;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_namespace_repo` ON `projects` (coalesce(`organization_id`, `user_id`),`repo_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_artifact_repo` ON `projects` (`artifact_repo_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_namespace_slug` ON `projects` (coalesce(`organization_id`, `user_id`),lower(`slug`));--> statement-breakpoint
CREATE INDEX `projects_organization` ON `projects` (`organization_id`);--> statement-breakpoint
ALTER TABLE `session` ADD `active_organization_id` text;--> statement-breakpoint
ALTER TABLE `user` ADD `username` text;--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);
