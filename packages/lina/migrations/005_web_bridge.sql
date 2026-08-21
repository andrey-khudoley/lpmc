-- Мост веб-интерфейса в реальный конвейер.
--
-- Веб-интерфейс (роль lpmc-web) не имеет доступа к схеме lina — границы контуров
-- в правах БД. Но «Передать исполнителю» должно завести НАСТОЯЩИЙ кандидат в
-- задачу, который пройдёт dispatch → PACT → MITA/CITA. Узкий канал для этого —
-- три функции SECURITY DEFINER, принадлежащие lpmc-lina: они исполняются с её
-- правами, но веб может только вызвать их (EXECUTE), а не трогать таблицы lina.
--
-- Кандидат подаётся как обращение канала cli от operator — той же формы, что
-- публикует адаптер LINA, — поэтому переиспользует привязку владельца, правило
-- и allowlist уже работающего сценария. Результат возвращается в lina.deliveries,
-- откуда веб читает его функцией web_deliveries.

-- Завести кандидат в задачу. Поля уже собраны вебом (Лина квалифицировала),
-- поэтому подаётся полный кандидат, а не сырое сообщение.
CREATE OR REPLACE FUNCTION lina.web_submit(p_objective text, p_owner text, p_dod text[], p_conv text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lina, pg_temp AS $$
DECLARE v_conv uuid; v_route uuid; v_req uuid := gen_random_uuid();
BEGIN
  INSERT INTO conversations (id, channel, adapter_id, external_conversation_id, external_actor_id)
    VALUES (gen_random_uuid(), 'cli', 'lina-cli', p_conv, 'operator')
    ON CONFLICT (channel, adapter_id, external_conversation_id) DO UPDATE SET last_activity_at = now()
    RETURNING id INTO v_conv;
  INSERT INTO reply_routes (id, channel, adapter_id, endpoint_id, conversation_id)
    VALUES (gen_random_uuid(), 'cli', 'lina-cli', p_conv, v_conv)
    ON CONFLICT (channel, adapter_id, endpoint_id, conversation_id) DO NOTHING;
  SELECT id INTO v_route FROM reply_routes
    WHERE channel = 'cli' AND adapter_id = 'lina-cli' AND conversation_id = v_conv AND revoked_at IS NULL
    ORDER BY created_at DESC LIMIT 1;
  INSERT INTO outbox (subject, event_type, schema_version, payload, correlation_id, dedup_key)
    VALUES ('requests.task-candidate.v1', 'request.submitted', '1.0.0',
      jsonb_build_object(
        'request_id', v_req::text,
        'recipient_candidate', jsonb_build_object('user_id', 'operator', 'system_id', 'lina-cli'),
        'task', jsonb_build_object('objective', p_objective, 'owner', p_owner,
          'dod', to_jsonb(p_dod), 'context_refs', '[]'::jsonb, 'requested_capabilities', '[]'::jsonb),
        'reply_route_id', v_route::text, 'channel', 'cli', 'adapter_id', 'lina-cli',
        'qualification', jsonb_build_object('confidence', null, 'qualifier_version', 'web-0', 'model_id', null)),
      v_conv::text, v_req::text);
  RETURN v_req::text;
END $$;

-- Прочитать доставленные результаты для диалога веба (результат MITA/CITA,
-- прошедший egress-проверку PACT). Значения возвращаются как есть.
CREATE OR REPLACE FUNCTION lina.web_deliveries(p_conv text)
RETURNS TABLE(text text, created_at timestamptz, ephemeral boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = lina, pg_temp AS $$
  SELECT d.text, d.created_at, d.ephemeral
    FROM deliveries d JOIN conversations c ON c.id = d.conversation_id
   WHERE c.external_conversation_id = p_conv AND c.channel = 'cli'
   ORDER BY d.created_at
$$;

-- Приёмка результата человеком из веба (accepted/rejected).
CREATE OR REPLACE FUNCTION lina.web_review(p_conv text, p_decision text, p_note text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = lina, pg_temp AS $$
DECLARE v_route uuid;
BEGIN
  SELECT r.id INTO v_route FROM reply_routes r JOIN conversations c ON c.id = r.conversation_id
   WHERE c.external_conversation_id = p_conv AND c.channel = 'cli' AND r.revoked_at IS NULL
   ORDER BY r.created_at DESC LIMIT 1;
  IF v_route IS NULL THEN RETURN false; END IF;
  INSERT INTO outbox (subject, event_type, schema_version, payload, correlation_id, dedup_key)
    VALUES ('reviews.decided.v1', 'review.decided', '1.0.0',
      jsonb_build_object('reply_route_id', v_route::text, 'channel', 'cli', 'adapter_id', 'lina-cli',
        'decision', p_decision, 'note', p_note, 'decided_by', 'web'),
      v_route::text, 'review:' || v_route::text || ':' || (extract(epoch from now()))::bigint::text);
  RETURN true;
END $$;
