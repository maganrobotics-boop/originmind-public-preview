CREATE TABLE `knowledge_revision_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`asset_path` text NOT NULL,
	`storage_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_revision_assets_revision_path_unique` ON `knowledge_revision_assets` (`revision_id`,`asset_path`);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_revision_assets_storage_key_unique` ON `knowledge_revision_assets` (`storage_key`);
--> statement-breakpoint
CREATE INDEX `knowledge_revision_assets_item_revision_idx` ON `knowledge_revision_assets` (`item_id`,`revision_id`,`asset_path`);
--> statement-breakpoint
CREATE TRIGGER `knowledge_revision_assets_validate_insert`
BEFORE INSERT ON `knowledge_revision_assets`
BEGIN
	SELECT CASE WHEN NEW.byte_size <= 0 THEN RAISE(ABORT, 'knowledge asset size must be positive') END;
	SELECT CASE WHEN length(NEW.sha256) <> 64 OR NEW.sha256 GLOB '*[^0-9a-f]*' THEN RAISE(ABORT, 'knowledge asset sha256 invalid') END;
	SELECT CASE WHEN NEW.asset_path NOT LIKE 'assets/%' THEN RAISE(ABORT, 'knowledge asset path must be under assets/') END;
	SELECT CASE WHEN NEW.mime_type NOT IN ('image/jpeg','image/png','image/webp') THEN RAISE(ABORT, 'knowledge asset mime type invalid') END;
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM knowledge_revisions r
		WHERE r.id = NEW.revision_id AND r.item_id = NEW.item_id
	) THEN RAISE(ABORT, 'knowledge asset revision mismatch') END;
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_revision_assets_immutable`
BEFORE UPDATE ON `knowledge_revision_assets`
BEGIN
	SELECT RAISE(ABORT, 'knowledge revision assets are immutable');
END;
