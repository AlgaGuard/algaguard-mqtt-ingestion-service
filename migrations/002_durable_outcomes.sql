ALTER TABLE ingestion_messages
  ADD COLUMN IF NOT EXISTS batch_id uuid,
  ADD COLUMN IF NOT EXISTS outcome jsonb;
CREATE INDEX IF NOT EXISTS ingestion_messages_device_time ON ingestion_messages(device_id,accepted_at DESC);
