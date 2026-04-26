-- Track the most recent error per source so the SOURCES tab can show whether
-- ingestion is actually healthy. Workers set these two columns inside their
-- catch blocks; clearing last_error happens on a successful poll.
--
-- Kept on sources itself rather than a separate log table — the operator view
-- only needs "what is the current state?", not "what was the full history?".
-- Full history lives in the worker logs.

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS last_error    TEXT,
  ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ;
