ALTER TABLE `projects` ADD `slug` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `visibility` text DEFAULT 'private' NOT NULL CONSTRAINT "projects_visibility" CHECK("visibility" IN ('public','private'));--> statement-breakpoint
ALTER TABLE `projects` ADD `pinned_at` integer;--> statement-breakpoint
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
CREATE UNIQUE INDEX `projects_user_slug` ON `projects` (`user_id`,lower(`slug`));--> statement-breakpoint
ALTER TABLE `user` ADD `username` text;--> statement-breakpoint
ALTER TABLE `user` ADD `bio` text;--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);
