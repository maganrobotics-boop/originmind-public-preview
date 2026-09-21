CREATE TABLE analytics_daily (
  day TEXT NOT NULL CHECK (
    length(day) = 10
    AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  event TEXT NOT NULL CHECK (event IN (
    'page_view',
    'chat_submit',
    'chat_success',
    'suggestion_impression',
    'suggestion_click',
    'new_chat',
    'install_success'
  )),
  section TEXT NOT NULL CHECK (section IN (
    'general',
    'technology',
    'academic',
    'company',
    'association'
  )),
  dimension TEXT DEFAULT '' NOT NULL CHECK (length(dimension) <= 300),
  count INTEGER DEFAULT 0 NOT NULL CHECK (count >= 0),
  PRIMARY KEY (day, event, section, dimension)
) WITHOUT ROWID;

CREATE INDEX idx_analytics_daily_event_day
  ON analytics_daily (event, day);
