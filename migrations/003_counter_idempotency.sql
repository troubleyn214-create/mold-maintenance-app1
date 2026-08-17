BEGIN;

ALTER TABLE shot_records
  ADD COLUMN counter_value BIGINT,
  ADD COLUMN idempotency_key TEXT;

ALTER TABLE shot_records
  ADD CONSTRAINT shot_records_counter_value_positive
    CHECK (counter_value IS NULL OR counter_value > 0),
  ADD CONSTRAINT shot_records_idempotency_key_length
    CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 16 AND 100),
  ADD CONSTRAINT shot_records_company_idempotency_unique
    UNIQUE (company_id, idempotency_key);

COMMIT;
