-- Runs once, when the local Postgres volume is first created.
-- Query-level statistics for performance investigations (see docs/runbooks).
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
