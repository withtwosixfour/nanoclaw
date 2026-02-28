CREATE TABLE `conversation_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text,
	`tool_calls` text,
	`tool_results` text,
	`token_count` integer,
	`created_at` text NOT NULL,
	`is_compacted` integer DEFAULT false,
	`compacted_at` text,
	`is_compacted_summary` integer DEFAULT false,
	`provider` text,
	`model` text
);
--> statement-breakpoint
CREATE INDEX `idx_conversation_session` ON `conversation_history` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_conversation_created` ON `conversation_history` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_conversation_compacted` ON `conversation_history` (`session_id`,`is_compacted`);