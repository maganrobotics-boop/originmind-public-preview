ALTER TABLE knowledge_revision_assets ADD COLUMN upload_token TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_revision_assets ADD COLUMN upload_state TEXT NOT NULL DEFAULT 'ready' CHECK (upload_state IN ('staged', 'ready'));
CREATE INDEX knowledge_revision_assets_upload_idx ON knowledge_revision_assets(revision_id, upload_token, upload_state);
