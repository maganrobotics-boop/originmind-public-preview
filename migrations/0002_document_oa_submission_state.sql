ALTER TABLE documents ADD COLUMN oa_submission_state TEXT DEFAULT 'unknown' NOT NULL CHECK (oa_submission_state IN ('unknown', 'unsubmitted', 'submitted'));

ALTER TABLE documents ADD COLUMN oa_item_id TEXT;

ALTER TABLE documents ADD COLUMN oa_submitted_at TEXT;

ALTER TABLE documents ADD COLUMN draft_revision INTEGER DEFAULT 1 NOT NULL CHECK (draft_revision >= 1);

CREATE INDEX idx_documents_oa_submission_state_updated ON documents (oa_submission_state, updated_at);
