BEGIN;

ALTER TABLE shot_molds ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE shot_records ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE shot_records ALTER COLUMN created_by_user_id SET NOT NULL;

ALTER TABLE shot_molds
  ADD CONSTRAINT shot_molds_company_fk FOREIGN KEY (company_id) REFERENCES companies(id),
  ADD CONSTRAINT shot_molds_id_company_unique UNIQUE (id, company_id);

ALTER TABLE shot_records
  ADD CONSTRAINT shot_records_company_fk FOREIGN KEY (company_id) REFERENCES companies(id),
  ADD CONSTRAINT shot_records_creator_fk FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  ADD CONSTRAINT shot_records_mold_company_fk FOREIGN KEY (mold_id, company_id)
    REFERENCES shot_molds(id, company_id) ON DELETE CASCADE;

CREATE INDEX shot_molds_company_lookup_idx ON shot_molds (company_id, id);
CREATE INDEX shot_records_company_mold_idx ON shot_records (company_id, mold_id, recorded_on DESC, id DESC);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions (expires_at);

COMMIT;
