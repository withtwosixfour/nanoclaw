CREATE TABLE `voice_sessions` (
	`voice_session_id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`platform_session_id` text NOT NULL,
	`route_key` text NOT NULL,
	`agent_id` text NOT NULL,
	`effective_prompt` text NOT NULL,
	`status` text NOT NULL,
	`started_by` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`linked_text_thread_id` text,
	`linked_text_session_id` text,
	`metadata_json` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_voice_sessions_platform` ON `voice_sessions` (`platform`);--> statement-breakpoint
CREATE INDEX `idx_voice_sessions_route` ON `voice_sessions` (`route_key`);--> statement-breakpoint
CREATE INDEX `idx_voice_sessions_status` ON `voice_sessions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_voice_sessions_started_at` ON `voice_sessions` (`started_at`);--> statement-breakpoint
CREATE TABLE `voice_participants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`voice_session_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`display_name` text NOT NULL,
	`joined_at` text NOT NULL,
	`left_at` text,
	FOREIGN KEY (`voice_session_id`) REFERENCES `voice_sessions`(`voice_session_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_voice_participants_session_participant` ON `voice_participants` (`voice_session_id`,`participant_id`);--> statement-breakpoint
CREATE TABLE `voice_transcripts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`voice_session_id` text NOT NULL,
	`participant_id` text,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`voice_session_id`) REFERENCES `voice_sessions`(`voice_session_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_voice_transcripts_session_created` ON `voice_transcripts` (`voice_session_id`,`created_at`);
