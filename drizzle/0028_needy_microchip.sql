ALTER TABLE `knowledge_items`
ADD COLUMN `visibility` text DEFAULT 'internal' NOT NULL
CONSTRAINT `knowledge_items_visibility_check` CHECK (`visibility` IN ('internal', 'public'));--> statement-breakpoint
CREATE INDEX `knowledge_items_visibility_status_updated_idx` ON `knowledge_items` (`visibility`,`status`,`updated_at`);--> statement-breakpoint
CREATE TRIGGER `knowledge_items_visibility_transition_guard`
BEFORE UPDATE OF `visibility` ON `knowledge_items`
WHEN NEW.`visibility` <> OLD.`visibility` AND NOT (
	OLD.`status` = 'pending'
	AND OLD.`visibility` = 'internal'
	AND NEW.`status` = 'active'
	AND NEW.`visibility` = 'public'
	AND NEW.`active_revision_id` = NEW.`current_revision_id`
)
BEGIN
	SELECT RAISE(ABORT, 'invalid knowledge visibility transition');
END;--> statement-breakpoint
CREATE TRIGGER `knowledge_events_action_guard`
BEFORE INSERT ON `knowledge_events`
WHEN NEW.`action` NOT IN ('submitted', 'resubmitted', 'approved', 'approved_internal', 'approved_public', 'returned', 'rejected', 'revoked')
BEGIN
	SELECT RAISE(ABORT, 'invalid knowledge event action');
END;
