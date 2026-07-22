CREATE TABLE ingestion_messages (message_id uuid PRIMARY KEY, device_id text NOT NULL, topic text NOT NULL, accepted_at timestamptz NOT NULL DEFAULT now());

