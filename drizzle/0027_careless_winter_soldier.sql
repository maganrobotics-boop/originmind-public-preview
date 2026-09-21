CREATE INDEX `knowledge_chunks_item_active_idx` ON `knowledge_chunks` (`item_id`,`is_active`);--> statement-breakpoint
CREATE TRIGGER `knowledge_items_identity_immutable`
BEFORE UPDATE OF `id`, `project`, `submitter_member_id`, `submitter_name`, `submitter_email`, `created_at` ON `knowledge_items`
BEGIN
	SELECT RAISE(ABORT, 'knowledge item identity is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `knowledge_items_status_transition_guard`
BEFORE UPDATE OF `status` ON `knowledge_items`
WHEN NOT (
	(OLD.`status` = 'pending' AND NEW.`status` IN ('active', 'returned', 'rejected'))
	OR (OLD.`status` = 'returned' AND NEW.`status` = 'pending')
	OR (OLD.`status` = 'active' AND NEW.`status` = 'revoked')
)
BEGIN
	SELECT RAISE(ABORT, 'invalid knowledge item status transition');
END;--> statement-breakpoint
CREATE TRIGGER `knowledge_items_no_delete`
BEFORE DELETE ON `knowledge_items`
BEGIN
	SELECT RAISE(ABORT, 'knowledge items cannot be deleted');
END;--> statement-breakpoint
CREATE TRIGGER `knowledge_revisions_content_immutable`
BEFORE UPDATE OF `id`, `item_id`, `revision_no`, `previous_revision_id`, `title`, `category`, `content`, `summary`, `source_label`, `source_url`, `content_hash`, `created_by_member_id`, `created_by_name`, `created_by_email`, `created_at` ON `knowledge_revisions`
BEGIN
	SELECT RAISE(ABORT, 'knowledge revision content is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `knowledge_revisions_lifecycle_guard`
BEFORE UPDATE OF `status`, `reviewed_by_member_id`, `reviewed_by_name`, `reviewed_by_email`, `review_note`, `reviewed_at`, `activated_at`, `retired_at` ON `knowledge_revisions`
WHEN NOT (
	(
		OLD.`status` = 'pending'
		AND NEW.`status` = 'active'
		AND NEW.`reviewed_by_member_id` IS NOT NULL AND length(trim(NEW.`reviewed_by_member_id`)) > 0
		AND NEW.`reviewed_by_name` IS NOT NULL AND length(trim(NEW.`reviewed_by_name`)) > 0
		AND NEW.`reviewed_by_email` IS NOT NULL AND length(trim(NEW.`reviewed_by_email`)) > 0
		AND NEW.`reviewed_at` IS NOT NULL
		AND NEW.`activated_at` = NEW.`reviewed_at`
		AND NEW.`retired_at` IS NULL
	)
	OR (
		OLD.`status` = 'pending'
		AND NEW.`status` IN ('returned', 'rejected')
		AND NEW.`reviewed_by_member_id` IS NOT NULL AND length(trim(NEW.`reviewed_by_member_id`)) > 0
		AND NEW.`reviewed_by_name` IS NOT NULL AND length(trim(NEW.`reviewed_by_name`)) > 0
		AND NEW.`reviewed_by_email` IS NOT NULL AND length(trim(NEW.`reviewed_by_email`)) > 0
		AND NEW.`reviewed_at` IS NOT NULL
		AND length(trim(NEW.`review_note`)) >= 2
		AND NEW.`activated_at` IS NULL
		AND NEW.`retired_at` IS NULL
	)
	OR (
		OLD.`status` = 'active'
		AND NEW.`status` IN ('superseded', 'revoked')
		AND NEW.`reviewed_by_member_id` IS OLD.`reviewed_by_member_id`
		AND NEW.`reviewed_by_name` IS OLD.`reviewed_by_name`
		AND NEW.`reviewed_by_email` IS OLD.`reviewed_by_email`
		AND NEW.`review_note` IS OLD.`review_note`
		AND NEW.`reviewed_at` IS OLD.`reviewed_at`
		AND NEW.`activated_at` IS OLD.`activated_at`
		AND NEW.`retired_at` IS NOT NULL
		AND julianday(NEW.`retired_at`) IS NOT NULL
		AND julianday(OLD.`activated_at`) IS NOT NULL
		AND julianday(NEW.`retired_at`) >= julianday(OLD.`activated_at`)
	)
)
BEGIN
	SELECT RAISE(ABORT, 'invalid knowledge revision lifecycle transition');
END;--> statement-breakpoint
CREATE TRIGGER `knowledge_revisions_no_delete`
BEFORE DELETE ON `knowledge_revisions`
BEGIN
	SELECT RAISE(ABORT, 'knowledge revisions are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `knowledge_chunks_content_immutable`
BEFORE UPDATE OF `id`, `item_id`, `revision_id`, `chunk_no`, `section_title`, `paragraph_ref`, `content`, `search_text`, `created_at` ON `knowledge_chunks`
BEGIN
	SELECT RAISE(ABORT, 'knowledge chunk content is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `knowledge_chunks_activation_guard`
BEFORE UPDATE OF `is_active` ON `knowledge_chunks`
WHEN NOT (NEW.`is_active` = OLD.`is_active` OR (OLD.`is_active` = 1 AND NEW.`is_active` = 0))
BEGIN
	SELECT RAISE(ABORT, 'knowledge chunks cannot be reactivated');
END;--> statement-breakpoint
CREATE TRIGGER `knowledge_chunks_no_delete`
BEFORE DELETE ON `knowledge_chunks`
BEGIN
	SELECT RAISE(ABORT, 'knowledge chunks cannot be deleted');
END;--> statement-breakpoint
CREATE TRIGGER `knowledge_events_no_update`
BEFORE UPDATE ON `knowledge_events`
BEGIN
	SELECT RAISE(ABORT, 'knowledge events are append-only');
END;--> statement-breakpoint
CREATE TRIGGER `knowledge_events_no_delete`
BEFORE DELETE ON `knowledge_events`
BEGIN
	SELECT RAISE(ABORT, 'knowledge events are append-only');
END;
