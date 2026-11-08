-- Trip chat (supabase/migrations/…_trip_chat.sql): messages, threads, replies, mentions, edits, deletes, reactions,
-- and the changes row that pages follow live. Run: supabase test db (CI's `supabase` job).
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

-- P: an account, the planner. A: an anonymous phone (Ann). B: another (Ben). X: an outsider.
insert into auth.users (id, aud, role, is_anonymous) values
  ('00000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000c', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-0000000000b1', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-0000000000ff', 'authenticated', 'authenticated', true);
do $$ begin perform set_config('t.first', core.first_invite(), true); end $$;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
do $$ begin
  perform core.make_account('sam', 'SSSSSSSSSSSSSSSS', current_setting('t.first'));
  perform set_config('t.p', core.make_invite(), true);
end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
do $$ begin
  perform core.make_account('pat', 'PPPPPPPPPPPPPPPP', current_setting('t.p'));
  perform set_config('t.trip', trip.make_trip('Tokyo', 'Pat')::text, true);
  perform set_config('t.ann', trip.add_person(current_setting('t.trip')::uuid, 'Ann')::text, true);
  perform set_config('t.ben', trip.add_person(current_setting('t.trip')::uuid, 'Ben')::text, true);
  perform set_config('t.code', trip.join_link(current_setting('t.trip')::uuid), true);
  perform set_config('t.plan', trip.add_section(current_setting('t.trip')::uuid, 'itinerary', 'Plan')::text, true);
  perform set_config('t.item', trip.add_item(current_setting('t.plan')::uuid, '{"title": "Ramen"}')::text, true);
end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
do $$ begin perform trip.claim(current_setting('t.code'), current_setting('t.ann')::uuid); end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000b1", "role": "authenticated"}';
do $$ begin perform trip.claim(current_setting('t.code'), current_setting('t.ben')::uuid); end $$;

reset role;
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('trip.messages'::regclass, 'trip.reactions'::regclass,
  'trip.changes'::regclass)), 'row level security is on for messages, reactions and changes');
select is((select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'trip'), 3::bigint,
  'messages, reactions and changes are published to Realtime');
set local role authenticated;

-- ---------- sending ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
do $$ begin perform set_config('t.m1', trip.send_message(current_setting('t.trip')::uuid, '  Who''s up for ramen? ' || chr(10),
  null, null, array[current_setting('t.ben'), '00000000-0000-0000-0000-0000000000ff']::uuid[])::text, true); end $$;
select is((select body from trip.messages where id = current_setting('t.m1')::bigint), 'Who''s up for ramen?', 'Ann (no account) sends a message, trimmed');
select is((select mentions from trip.messages where id = current_setting('t.m1')::bigint), array[current_setting('t.ben')::uuid],
  'mentions keep only people on the trip');
select throws_ok($$ select trip.send_message(current_setting('t.trip')::uuid, '   ') $$, '23514', null, 'an empty message is refused');
select throws_ok($$ select trip.send_message(current_setting('t.trip')::uuid, repeat('a', 2001)) $$, '23514', null, 'and one over 2000 characters');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000b1", "role": "authenticated"}';
do $$ begin perform set_config('t.m2', trip.send_message(current_setting('t.trip')::uuid, 'Me!', current_setting('t.m1')::bigint)::text, true); end $$;
select is((select reply_to from trip.messages where id = current_setting('t.m2')::bigint), current_setting('t.m1')::bigint, 'Ben replies to it');
do $$ begin perform set_config('t.m3', trip.send_message(current_setting('t.trip')::uuid, 'Which shop?', null, current_setting('t.item')::uuid)::text, true); end $$;
select is((select about from trip.messages where id = current_setting('t.m3')::bigint), current_setting('t.item')::uuid, 'and comments on the Ramen item');
select throws_ok($$ select trip.send_message(current_setting('t.trip')::uuid, 'x', null, gen_random_uuid()) $$, 'RCTRP', null,
  'only on items of the trip');

-- ---------- who reads it ----------
select is((select count(*) from trip.messages), 3::bigint, 'Ben reads the chat');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000ff", "role": "authenticated"}';
select is((select count(*) from trip.messages) + (select count(*) from trip.changes), 0::bigint, 'X, not on the trip, reads nothing');
select throws_ok($$ select trip.send_message(current_setting('t.trip')::uuid, 'hi') $$, 'RCTRP', null, 'and can''t write');
select throws_ok($$ insert into trip.messages (trip_id, person_id, body) values (current_setting('t.trip')::uuid, current_setting('t.ann')::uuid, 'fake') $$,
  '42501', null, 'nobody writes the table directly');

-- ---------- reactions ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000b1", "role": "authenticated"}';
select lives_ok($$ select trip.react(current_setting('t.m1')::bigint, '🍜', true) $$, 'Ben reacts 🍜');
select lives_ok($$ select trip.react(current_setting('t.m1')::bigint, '🍜', true) $$, 'twice is still once');
select lives_ok($$ select trip.react(current_setting('t.m1')::bigint, '👍', true) $$, 'and 👍 too');
select is((select count(*) from trip.reactions), 2::bigint, 'two reactions');
select lives_ok($$ select trip.react(current_setting('t.m1')::bigint, '👍', false) $$, 'he takes 👍 back');
select throws_ok($$ select trip.react(current_setting('t.m1')::bigint, '<b>', true) $$, '23514', null, 'reactions are emoji, not markup');

-- ---------- editing and deleting ----------
select throws_ok($$ select trip.edit_message(current_setting('t.m1')::bigint, 'hacked') $$, 'RCTRP', null, 'Ben can''t change Ann''s message');
select throws_ok($$ select trip.delete_message(current_setting('t.m1')::bigint) $$, 'RCTRP', null, 'or delete it');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
select lives_ok($$ select trip.edit_message(current_setting('t.m1')::bigint, 'Who''s up for ramen tonight?') $$, 'Ann edits hers');
select ok((select edited_at is not null from trip.messages where id = current_setting('t.m1')::bigint), 'it shows as edited');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select lives_ok($$ select trip.delete_message(current_setting('t.m2')::bigint) $$, 'P, a planner, deletes Ben''s reply');
select is((select body || coalesce(deleted_at::text <> '', false)::text from trip.messages where id = current_setting('t.m2')::bigint), 'true',
  'its text is gone, the mark stays');
select is((select array_agg(action order by id) from trip.log where action like 'message.%'), array['message.edit', 'message.delete'],
  'edits and deletes are logged');
select ok((select version from trip.changes) = (select version from trip.trips), 'the changes row follows the trip''s version');

select * from finish();
rollback;
