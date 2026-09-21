CREATE TABLE `knowledge_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`chunk_no` integer NOT NULL,
	`section_title` text DEFAULT '' NOT NULL,
	`paragraph_ref` text DEFAULT '' NOT NULL,
	`content` text NOT NULL,
	`search_text` text NOT NULL,
	`is_active` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "knowledge_chunks_number_check" CHECK("knowledge_chunks"."chunk_no" > 0),
	CONSTRAINT "knowledge_chunks_active_check" CHECK("knowledge_chunks"."is_active" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_chunks_revision_no_unique` ON `knowledge_chunks` (`revision_id`,`chunk_no`);--> statement-breakpoint
CREATE INDEX `knowledge_chunks_active_item_chunk_idx` ON `knowledge_chunks` (`is_active`,`item_id`,`chunk_no`);--> statement-breakpoint
CREATE TABLE `knowledge_events` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`revision_id` text,
	`actor_member_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`actor_email` text NOT NULL,
	`action` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `knowledge_events_item_created_idx` ON `knowledge_events` (`item_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `knowledge_events_actor_created_idx` ON `knowledge_events` (`actor_member_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `knowledge_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`title` text NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`submitter_member_id` text NOT NULL,
	`submitter_name` text NOT NULL,
	`submitter_email` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_revision_no` integer DEFAULT 0 NOT NULL,
	`current_revision_id` text,
	`active_revision_id` text,
	`mutation_revision` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_at` text,
	CONSTRAINT "knowledge_items_status_check" CHECK("knowledge_items"."status" IN ('pending', 'returned', 'rejected', 'active', 'revoked')),
	CONSTRAINT "knowledge_items_mutation_revision_check" CHECK(length("knowledge_items"."mutation_revision") > 0),
	CONSTRAINT "knowledge_items_revision_pointer_check" CHECK(("knowledge_items"."current_revision_no" = 0 AND "knowledge_items"."current_revision_id" IS NULL) OR ("knowledge_items"."current_revision_no" > 0 AND "knowledge_items"."current_revision_id" IS NOT NULL)),
	CONSTRAINT "knowledge_items_active_pointer_check" CHECK(("knowledge_items"."status" = 'active' AND "knowledge_items"."active_revision_id" IS NOT NULL) OR ("knowledge_items"."status" <> 'active' AND "knowledge_items"."active_revision_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `knowledge_items_status_updated_idx` ON `knowledge_items` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `knowledge_items_submitter_created_idx` ON `knowledge_items` (`submitter_member_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_items_current_revision_unique` ON `knowledge_items` (`current_revision_id`) WHERE "knowledge_items"."current_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_items_active_revision_unique` ON `knowledge_items` (`active_revision_id`) WHERE "knowledge_items"."active_revision_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `knowledge_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`revision_no` integer NOT NULL,
	`previous_revision_id` text,
	`title` text NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`content` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`source_label` text DEFAULT '' NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`content_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_by_member_id` text NOT NULL,
	`created_by_name` text NOT NULL,
	`created_by_email` text NOT NULL,
	`reviewed_by_member_id` text,
	`reviewed_by_name` text,
	`reviewed_by_email` text,
	`review_note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`reviewed_at` text,
	`activated_at` text,
	`retired_at` text,
	CONSTRAINT "knowledge_revisions_number_check" CHECK("knowledge_revisions"."revision_no" > 0),
	CONSTRAINT "knowledge_revisions_status_check" CHECK("knowledge_revisions"."status" IN ('pending', 'returned', 'rejected', 'active', 'superseded', 'revoked')),
	CONSTRAINT "knowledge_revisions_content_hash_check" CHECK(length("knowledge_revisions"."content_hash") = 64 AND "knowledge_revisions"."content_hash" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_revisions_item_no_unique` ON `knowledge_revisions` (`item_id`,`revision_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_revisions_item_hash_unique` ON `knowledge_revisions` (`item_id`,`content_hash`);--> statement-breakpoint
CREATE INDEX `knowledge_revisions_item_status_created_idx` ON `knowledge_revisions` (`item_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TRIGGER `knowledge_items_migration_freeze_insert` BEFORE INSERT ON `knowledge_items` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_items_migration_freeze_update` BEFORE UPDATE ON `knowledge_items` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_items_migration_freeze_delete` BEFORE DELETE ON `knowledge_items` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_revisions_migration_freeze_insert` BEFORE INSERT ON `knowledge_revisions` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_revisions_migration_freeze_update` BEFORE UPDATE ON `knowledge_revisions` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_revisions_migration_freeze_delete` BEFORE DELETE ON `knowledge_revisions` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_chunks_migration_freeze_insert` BEFORE INSERT ON `knowledge_chunks` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_chunks_migration_freeze_update` BEFORE UPDATE ON `knowledge_chunks` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_chunks_migration_freeze_delete` BEFORE DELETE ON `knowledge_chunks` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_events_migration_freeze_insert` BEFORE INSERT ON `knowledge_events` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_events_migration_freeze_update` BEFORE UPDATE ON `knowledge_events` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_events_migration_freeze_delete` BEFORE DELETE ON `knowledge_events` WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL) BEGIN SELECT RAISE(ABORT, 'migration write freeze active'); END;
