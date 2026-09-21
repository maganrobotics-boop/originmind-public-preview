DROP TRIGGER `knowledge_items_visibility_transition_guard`;--> statement-breakpoint
CREATE TRIGGER `knowledge_items_visibility_transition_guard`
BEFORE UPDATE OF `visibility` ON `knowledge_items`
WHEN NEW.`visibility` <> OLD.`visibility` AND NOT (
	(
		OLD.`status` = 'pending'
		AND OLD.`visibility` = 'internal'
		AND NEW.`status` = 'active'
		AND NEW.`visibility` = 'public'
		AND NEW.`active_revision_id` = NEW.`current_revision_id`
	)
	OR (
		OLD.`status` = 'active'
		AND NEW.`status` = 'active'
		AND OLD.`visibility` IN ('internal', 'public')
		AND NEW.`visibility` IN ('internal', 'public')
		AND NEW.`title` IS OLD.`title`
		AND NEW.`category` IS OLD.`category`
		AND NEW.`current_revision_no` IS OLD.`current_revision_no`
		AND NEW.`current_revision_id` IS OLD.`current_revision_id`
		AND NEW.`active_revision_id` IS OLD.`active_revision_id`
		AND NEW.`active_revision_id` = NEW.`current_revision_id`
		AND NEW.`revoked_at` IS OLD.`revoked_at`
		AND NEW.`mutation_revision` <> OLD.`mutation_revision`
		AND NEW.`updated_at` <> OLD.`updated_at`
	)
)
BEGIN
	SELECT RAISE(ABORT, 'invalid knowledge visibility transition');
END;--> statement-breakpoint
DROP TRIGGER `knowledge_events_action_guard`;--> statement-breakpoint
CREATE TRIGGER `knowledge_events_action_guard`
BEFORE INSERT ON `knowledge_events`
WHEN NEW.`action` NOT IN (
	'submitted',
	'resubmitted',
	'approved',
	'approved_internal',
	'approved_public',
	'visibility_changed_internal',
	'visibility_changed_public',
	'returned',
	'rejected',
	'revoked'
)
BEGIN
	SELECT RAISE(ABORT, 'invalid knowledge event action');
END;
