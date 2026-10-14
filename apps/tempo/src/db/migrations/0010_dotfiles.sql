CREATE TABLE `dotfiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`artifact_repo_id` text NOT NULL,
	`repo_name` text NOT NULL,
	`clone_url` text NOT NULL,
	`head_sha` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dotfiles_repo_name_unique` ON `dotfiles` (`repo_name`);