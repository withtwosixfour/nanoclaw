CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`folder` text NOT NULL,
	`name` text NOT NULL,
	`trigger_pattern` text NOT NULL,
	`added_at` text NOT NULL,
	`requires_trigger` integer DEFAULT true,
	`model_provider` text DEFAULT 'opencode-zen',
	`model_name` text DEFAULT 'kimi-k2.5',
	`is_main` integer DEFAULT false
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_folder_unique` ON `agents` (`folder`);--> statement-breakpoint
CREATE INDEX `idx_agents_folder` ON `agents` (`folder`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`chat_jid` text NOT NULL,
	`filename` text NOT NULL,
	`path` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_attachments_message` ON `attachments` (`message_id`,`chat_jid`);--> statement-breakpoint
CREATE TABLE `chat_sdk_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX `idx_chat_sdk_cache_expires` ON `chat_sdk_cache` (`expires_at`);--> statement-breakpoint
CREATE TABLE `chat_sdk_locks` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX `idx_chat_sdk_locks_expires` ON `chat_sdk_locks` (`expires_at`);--> statement-breakpoint
CREATE TABLE `chat_sdk_subscriptions` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE `chats` (
	`jid` text PRIMARY KEY NOT NULL,
	`name` text,
	`last_message_time` text,
	`channel` text,
	`is_group` integer DEFAULT false
);
--> statement-breakpoint
CREATE INDEX `idx_chats_last_message_time` ON `chats` (`last_message_time`);--> statement-breakpoint
CREATE TABLE `conversation_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`jid` text NOT NULL,
	`agent_id` text NOT NULL,
	`role` text NOT NULL,
	`message` text,
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
CREATE INDEX `idx_conversation_jid` ON `conversation_history` (`jid`);--> statement-breakpoint
CREATE INDEX `idx_conversation_agent` ON `conversation_history` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_conversation_created` ON `conversation_history` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_conversation_compacted` ON `conversation_history` (`session_id`,`is_compacted`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text NOT NULL,
	`chat_jid` text NOT NULL,
	`sender` text NOT NULL,
	`sender_name` text,
	`content` text,
	`timestamp` text NOT NULL,
	`is_from_me` integer DEFAULT false,
	`is_bot_message` integer DEFAULT false,
	PRIMARY KEY(`id`, `chat_jid`),
	FOREIGN KEY (`chat_jid`) REFERENCES `chats`(`jid`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_messages_timestamp` ON `messages` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_messages_chat_jid` ON `messages` (`chat_jid`);--> statement-breakpoint
CREATE TABLE `router_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `routes` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_routes_agent` ON `routes` (`agent_id`);--> statement-breakpoint
CREATE TABLE `scheduled_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`chat_jid` text NOT NULL,
	`thread_id` text,
	`prompt` text NOT NULL,
	`schedule_type` text NOT NULL,
	`schedule_value` text NOT NULL,
	`context_mode` text DEFAULT 'isolated',
	`next_run` text,
	`last_run` text,
	`last_result` text,
	`status` text DEFAULT 'active',
	`created_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_next_run` ON `scheduled_tasks` (`next_run`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_status` ON `scheduled_tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_thread_id` ON `scheduled_tasks` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_agent` ON `scheduled_tasks` (`agent_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`jid` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`session_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_agent` ON `sessions` (`agent_id`);--> statement-breakpoint
CREATE TABLE `task_run_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`run_at` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`error` text,
	FOREIGN KEY (`task_id`) REFERENCES `scheduled_tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_task_run_logs` ON `task_run_logs` (`task_id`,`run_at`);--> statement-breakpoint
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