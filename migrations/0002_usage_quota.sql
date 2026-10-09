-- Daily usage counters. scope = "<kind>:<provider>:<account id>" per account, or "site" for the whole site.
-- day = calendar date in Asia/Bangkok (UTC+7), so quotas reset at 00:00 Thai time.
CREATE TABLE IF NOT EXISTS usage_counters (
  scope TEXT NOT NULL,
  day TEXT NOT NULL,
  units INTEGER NOT NULL,
  PRIMARY KEY (scope, day)
);
