-- Keep uploaded bytes and their identity immutable; only complete a pending upload.
DROP TRIGGER `knowledge_revision_assets_immutable`;
--> statement-breakpoint
CREATE TRIGGER `knowledge_revision_assets_immutable`
BEFORE UPDATE ON `knowledge_revision_assets`
BEGIN
	SELECT CASE WHEN EXISTS (SELECT 1 FROM migration_control WHERE deactivated_at IS NULL)
		THEN RAISE(ABORT, 'migration write freeze active') END;
	SELECT CASE WHEN NOT (
		OLD.upload_state = 'staged' AND NEW.upload_state = 'ready'
		AND NEW.id IS OLD.id AND NEW.item_id IS OLD.item_id
		AND NEW.revision_id IS OLD.revision_id AND NEW.asset_path IS OLD.asset_path
		AND NEW.storage_key IS OLD.storage_key AND NEW.mime_type IS OLD.mime_type
		AND NEW.byte_size IS OLD.byte_size AND NEW.sha256 IS OLD.sha256
		AND NEW.created_at IS OLD.created_at AND NEW.upload_token IS OLD.upload_token
		AND length(NEW.upload_token) > 0
		AND EXISTS (
			SELECT 1 FROM knowledge_items i JOIN knowledge_revisions r
			ON r.id = i.current_revision_id AND r.item_id = i.id
			WHERE i.id = NEW.item_id AND r.id = NEW.revision_id
			AND i.status = 'pending' AND r.status = 'pending'
		)
	) THEN RAISE(ABORT, 'knowledge revision assets are immutable') END;
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_revision_assets_pending_insert`
BEFORE INSERT ON `knowledge_revision_assets`
BEGIN
	SELECT CASE WHEN EXISTS (SELECT 1 FROM migration_control WHERE deactivated_at IS NULL)
		THEN RAISE(ABORT, 'migration write freeze active') END;
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM knowledge_items i JOIN knowledge_revisions r
		ON r.id = i.current_revision_id AND r.item_id = i.id
		WHERE i.id = NEW.item_id AND r.id = NEW.revision_id
		AND i.status = 'pending' AND r.status = 'pending'
	) THEN RAISE(ABORT, 'knowledge revision is not pending') END;
	SELECT CASE WHEN NEW.upload_state = 'staged' AND (
		length(NEW.upload_token) = 0 OR EXISTS (
			SELECT 1 FROM knowledge_revision_assets
			WHERE revision_id = NEW.revision_id AND upload_state = 'ready'
		)
	) THEN RAISE(ABORT, 'knowledge upload is already finalized or has no token') END;
END;
