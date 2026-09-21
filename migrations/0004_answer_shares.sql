CREATE TABLE answer_shares (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL CHECK(length(question) <= 2000),
  answer TEXT NOT NULL CHECK(length(answer) BETWEEN 1 AND 12000),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX idx_answer_shares_expires ON answer_shares(expires_at);
