-- Исход проверки пункта DoD — три значения, а не «да/нет» (MITA §15.4).
--
-- Булев признак не различал «проверено и не выполнено» и «проверить было нечем»,
-- а разница принципиальная: первое означает, что работа не сделана, второе — что
-- о работе ничего не известно. Смешение позволяло бы закрывать задачу там, где
-- проверки не было вовсе.
ALTER TABLE dod_checks ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE dod_checks ADD COLUMN IF NOT EXISTS method text;
ALTER TABLE dod_checks ADD COLUMN IF NOT EXISTS artifact_ref uuid;

UPDATE dod_checks SET outcome = CASE WHEN verified THEN 'verified' ELSE 'not_checked' END
 WHERE outcome IS NULL;
UPDATE dod_checks SET method = observation WHERE method IS NULL;

ALTER TABLE dod_checks ALTER COLUMN outcome SET NOT NULL;
ALTER TABLE dod_checks ALTER COLUMN method SET NOT NULL;
ALTER TABLE dod_checks ADD CONSTRAINT dod_checks_outcome
  CHECK (outcome IN ('verified', 'failed', 'not_checked'));
ALTER TABLE dod_checks ALTER COLUMN verified DROP NOT NULL;
ALTER TABLE dod_checks ALTER COLUMN observation DROP NOT NULL;
