CREATE TABLE documents (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT DEFAULT '' NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('student', 'research', 'business')),
  updated_at TEXT NOT NULL,
  published INTEGER DEFAULT 0 NOT NULL CHECK (published IN (0, 1))
);

CREATE TABLE inquiries (
  id TEXT PRIMARY KEY NOT NULL,
  reference TEXT NOT NULL,
  request_id TEXT NOT NULL,
  name TEXT NOT NULL,
  organisation TEXT NOT NULL,
  contact TEXT NOT NULL,
  topic TEXT NOT NULL CHECK (topic IN ('student', 'research', 'business')),
  summary TEXT NOT NULL,
  transcript TEXT NOT NULL,
  status TEXT DEFAULT 'pending' NOT NULL CHECK (status IN ('pending', 'replied', 'closed')),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX inquiries_reference_unique ON inquiries (reference);
CREATE UNIQUE INDEX inquiries_request_id_unique ON inquiries (request_id);
CREATE INDEX idx_inquiries_status_created ON inquiries (status, created_at);

CREATE TABLE limits (
  key TEXT PRIMARY KEY NOT NULL,
  count INTEGER DEFAULT 0 NOT NULL,
  expires INTEGER NOT NULL
);

CREATE INDEX idx_limits_expires ON limits (expires);

CREATE TABLE settings (
  id TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE admin_account (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  algorithm TEXT NOT NULL CHECK (algorithm = 'PBKDF2-SHA-256'),
  iterations INTEGER NOT NULL CHECK (iterations BETWEEN 100000 AND 1000000),
  salt TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE sessions (
  hash TEXT PRIMARY KEY NOT NULL,
  expires INTEGER NOT NULL
);

CREATE INDEX sessions_expires ON sessions (expires);
