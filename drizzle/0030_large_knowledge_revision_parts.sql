CREATE TABLE `knowledge_revision_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`part_no` integer NOT NULL,
	`content` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "knowledge_revision_parts_number_check" CHECK("knowledge_revision_parts"."part_no" > 0),
	CONSTRAINT "knowledge_revision_parts_content_length_check" CHECK(length("knowledge_revision_parts"."content") BETWEEN 1 AND 20000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_revision_parts_revision_no_unique` ON `knowledge_revision_parts` (`revision_id`,`part_no`);--> statement-breakpoint
CREATE INDEX `knowledge_revision_parts_item_revision_idx` ON `knowledge_revision_parts` (`item_id`,`revision_id`,`part_no`);--> statement-breakpoint
CREATE TRIGGER `knowledge_revision_parts_relationship_guard`
BEFORE INSERT ON `knowledge_revision_parts`
WHEN NOT EXISTS (
	SELECT 1
	FROM `knowledge_revisions`
	WHERE `id` = NEW.`revision_id`
		AND `item_id` = NEW.`item_id`
		AND `content` = ''
		AND `created_at` = NEW.`created_at`
)
BEGIN
	SELECT RAISE(ABORT, 'knowledge revision part relationship is invalid');
END;--> statement-breakpoint
CREATE TRIGGER `knowledge_revision_parts_content_immutable`
BEFORE UPDATE OF `id`, `item_id`, `revision_id`, `part_no`, `content`, `created_at` ON `knowledge_revision_parts`
BEGIN
	SELECT RAISE(ABORT, 'knowledge revision part content is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `knowledge_revision_parts_no_delete`
BEFORE DELETE ON `knowledge_revision_parts`
BEGIN
	SELECT RAISE(ABORT, 'knowledge revision parts cannot be deleted');
END;--> statement-breakpoint
CREATE TRIGGER `knowledge_revision_parts_migration_freeze_insert`
BEFORE INSERT ON `knowledge_revision_parts`
WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL)
BEGIN
	SELECT RAISE(ABORT, 'migration write freeze active');
END;--> statement-breakpoint
CREATE TRIGGER `knowledge_revision_parts_migration_freeze_update`
BEFORE UPDATE ON `knowledge_revision_parts`
WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL)
BEGIN
	SELECT RAISE(ABORT, 'migration write freeze active');
END;--> statement-breakpoint
CREATE TRIGGER `knowledge_revision_parts_migration_freeze_delete`
BEFORE DELETE ON `knowledge_revision_parts`
WHEN EXISTS (SELECT 1 FROM `migration_control` WHERE `deactivated_at` IS NULL)
BEGIN
	SELECT RAISE(ABORT, 'migration write freeze active');
END;
