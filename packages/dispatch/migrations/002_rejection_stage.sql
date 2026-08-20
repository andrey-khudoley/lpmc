-- Этап, на котором обращение было отвергнуто.
--
-- DLQ у каждого этапа своя, и это не формальность: попадание в очередь разбора
-- приёма и в очередь разбора квалификации означает разные вещи — сломанный
-- продюсер в первом случае и неспособность квалифицировать во втором. Слить их
-- в одну очередь значило бы потерять различие ровно там, где оно нужно.
ALTER TABLE rejections ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'task-ingress';
ALTER TABLE rejections ADD CONSTRAINT rejections_stage
  CHECK (stage IN ('task-ingress', 'qualification'));
GRANT SELECT ON dispatch.rejections TO "lpmc-pact";
