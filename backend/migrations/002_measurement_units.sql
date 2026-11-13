-- Additive upgrade for instrument re-uploads in μm/nm.
-- The base table is bootstrapped by SQLAlchemy; apply this file once on existing databases.
-- Re-running is safe: every step is guarded.
ALTER TABLE measurements ADD COLUMN IF NOT EXISTS raw_value double precision;
ALTER TABLE measurements ADD COLUMN IF NOT EXISTS raw_unit varchar(8);
UPDATE measurements SET raw_value=value WHERE raw_value IS NULL;
UPDATE measurements SET raw_unit='μm' WHERE raw_unit IS NULL;
ALTER TABLE measurements ALTER COLUMN raw_value SET NOT NULL;
ALTER TABLE measurements ALTER COLUMN raw_unit SET NOT NULL;
ALTER TABLE measurements ALTER COLUMN raw_unit SET DEFAULT 'μm';
CREATE INDEX IF NOT EXISTS measurement_source_key_idx ON measurements (source_key);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='measurement_raw_unit_check' AND conrelid='measurements'::regclass) THEN
    ALTER TABLE measurements ADD CONSTRAINT measurement_raw_unit_check CHECK (raw_value > 0 AND raw_unit IN ('μm','nm'));
  END IF;
END $$;
