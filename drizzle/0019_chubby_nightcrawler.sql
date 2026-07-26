ALTER TABLE `thread_state` ADD `last_activity_at` integer;--> statement-breakpoint
ALTER TABLE `thread_state` ADD `last_inbound_at` integer;--> statement-breakpoint
CREATE INDEX `thread_state_list_idx` ON `thread_state` (`mailbox_id`,`placement`,`last_activity_at`) WHERE "thread_state"."hidden_at" is null;--> statement-breakpoint
CREATE INDEX `thread_state_unread_idx` ON `thread_state` (`mailbox_id`,`placement`,`last_inbound_at`) WHERE "thread_state"."hidden_at" is null;--> statement-breakpoint
CREATE INDEX `draft_status_updated_idx` ON `draft` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `send_counter_window_idx` ON `send_counter` (`window_start`);--> statement-breakpoint
--> backfill the new denormalized recency columns for existing threads
UPDATE `thread_state` SET `last_activity_at` = (
  SELECT `last_message_at` FROM `thread` WHERE `thread`.`id` = `thread_state`.`thread_id`
);--> statement-breakpoint
UPDATE `thread_state` SET `last_inbound_at` = (
  SELECT MAX(`m`.`sent_at`) FROM `delivery` `d`
  JOIN `message` `m` ON `m`.`id` = `d`.`message_id`
  WHERE `d`.`mailbox_id` = `thread_state`.`mailbox_id`
    AND `m`.`thread_id` = `thread_state`.`thread_id`
    AND `d`.`role` <> 'from'
);--> statement-breakpoint
--> teach the planner join order + index selectivity (D1 has no stats until now)
ANALYZE;