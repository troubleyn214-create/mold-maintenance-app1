BEGIN;

CREATE TABLE maintenance_records (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  mold_id BIGINT NOT NULL,
  created_by_user_id BIGINT NOT NULL REFERENCES users(id),
  performed_on DATE NOT NULL,
  counter_value BIGINT NOT NULL CHECK (counter_value >= 0),
  details TEXT NOT NULL CHECK (char_length(details) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mold_id, company_id)
    REFERENCES shot_molds(id, company_id) ON DELETE CASCADE
);

CREATE INDEX maintenance_records_company_mold_date_idx
  ON maintenance_records (company_id, mold_id, performed_on DESC, id DESC);

COMMIT;
