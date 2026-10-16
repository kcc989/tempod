CREATE TABLE `model_lists` (
	`user_id` text PRIMARY KEY NOT NULL,
	`models_json` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
