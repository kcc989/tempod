CREATE TABLE `issue_numbers` (
	`project_id` text PRIMARY KEY NOT NULL,
	`last_number` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "issue_numbers_nonnegative" CHECK("issue_numbers"."last_number" >= 0)
);

--> statement-breakpoint
INSERT INTO `issue_numbers` (`project_id`, `last_number`)
SELECT `project_id`, MAX(`number`) FROM `issues` GROUP BY `project_id`;
