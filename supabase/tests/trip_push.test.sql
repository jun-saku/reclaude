-- Trip push notifications (supabase/migrations/…_trip_push.sql): saving subscriptions, settings, who's told about a
-- message, and the request to the game server. Run: supabase test db (CI's `supabase` job).
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

-- P: an account, the planner. A: Ann's phone. B: Ben's phone. X: an outsider.
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
  perform set_config('t.pat', trip.me(current_setting('t.trip')::uuid)::text, true);
  perform set_config('t.ann', trip.add_person(current_setting('t.trip')::uuid, 'Ann')::text, true);
  perform set_config('t.ben', trip.add_person(current_setting('t.trip')::uuid, 'Ben')::text, true);
  perform set_config('t.code', trip.join_link(current_setting('t.trip')::uuid), true);
  perform set_config('t.plan', trip.add_section(current_setting('t.trip')::uuid, 'itinerary', 'Plan')::text, true);
  perform set_config('t.item', trip.add_item(current_setting('t.plan')::uuid, '{"title": "Ramen"}')::text, true);
  perform trip.save_push('https://push.example/pat', repeat('P', 87), repeat('p', 22));
end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
do $$ begin
  perform trip.claim(current_setting('t.code'), current_setting('t.ann')::uuid);
  perform trip.save_push('https://push.example/ann', repeat('A', 87), repeat('a', 22));
end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000b1", "role": "authenticated"}';
do $$ begin perform trip.claim(current_setting('t.code'), current_setting('t.ben')::uuid); end $$;

reset role;
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('trip.push_subs'::regclass, 'trip.push_prefs'::regclass)),
  'row level security is on for subscriptions and settings');
set local role authenticated;

-- ---------- subscriptions and settings ----------
select lives_ok($$ select trip.save_push('https://push.example/ben', repeat('B', 87), repeat('b', 22)) $$, 'Ben''s phone (no account) saves its subscription');
select throws_ok($$ select trip.save_push('http://push.example/x', repeat('B', 87), repeat('b', 22)) $$, '23514', null, 'push addresses are https');
select throws_ok($$ select * from trip.push_subs $$, '42501', null, 'nobody reads subscriptions through the API');
select is(trip.push_settings(current_setting('t.trip')::uuid) ->> 'mentions', 'true', 'mentions notify by default');
select is((trip.push_settings(current_setting('t.trip')::uuid) ->> 'phones')::int, 1, 'Ben has one phone getting them');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000ff", "role": "authenticated"}';
select throws_ok($$ select trip.push_settings(current_setting('t.trip')::uuid) $$, 'RCTRP', null, 'X, not on the trip, has no settings there');
select lives_ok($$ select trip.drop_push('https://push.example/ben') $$, 'X can''t drop Ben''s phone (nothing happens)');
reset role;
select is((select count(*) from trip.push_subs), 3::bigint, 'all three phones are still there');
set local role authenticated;

-- ---------- who's told ----------
-- (as the database sees a message: trip.push_targets)
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000b1", "role": "authenticated"}';
do $$ begin perform set_config('t.m1', trip.send_message(current_setting('t.trip')::uuid, 'Hi all')::text, true); end $$;
reset role;
select is(jsonb_array_length(trip.push_targets((select m from trip.messages m where id = current_setting('t.m1')::bigint))), 0,
  'a plain message tells nobody by default');
set local role authenticated;
do $$ begin perform set_config('t.m2', trip.send_message(current_setting('t.trip')::uuid, '@Ann ramen?', null, null,
  array[current_setting('t.ann')]::uuid[])::text, true); end $$;
reset role;
select is(trip.push_targets((select m from trip.messages m where id = current_setting('t.m2')::bigint)) -> 0 ->> 'endpoint',
  'https://push.example/ann', 'a mention tells Ann''s phone');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
do $$ begin perform set_config('t.m3', trip.send_message(current_setting('t.trip')::uuid, 'Yes!', current_setting('t.m2')::bigint)::text, true); end $$;
do $$ begin perform set_config('t.m4', trip.send_message(current_setting('t.trip')::uuid, 'Book it?', null, current_setting('t.item')::uuid)::text, true); end $$;
reset role;
select is(trip.push_targets((select m from trip.messages m where id = current_setting('t.m3')::bigint)) -> 0 ->> 'endpoint',
  'https://push.example/ben', 'a reply tells the writer it answers (Ben)');
select is(trip.push_targets((select m from trip.messages m where id = current_setting('t.m4')::bigint)) -> 0 ->> 'endpoint',
  'https://push.example/pat', 'a comment tells whoever added the item (Pat, by his account)');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select lives_ok($$ select trip.set_push_settings(current_setting('t.trip')::uuid, true, true, false, true) $$,
  'Pat turns comments off and every message on');
reset role;
select is(jsonb_array_length(trip.push_targets((select m from trip.messages m where id = current_setting('t.m4')::bigint))), 0,
  'now the comment doesn''t tell him');
select is(trip.push_targets((select m from trip.messages m where id = current_setting('t.m1')::bigint)) -> 0 ->> 'endpoint',
  'https://push.example/pat', 'but every chat message does');
select is(jsonb_array_length(trip.push_targets((select m from trip.messages m where id = current_setting('t.m3')::bigint))), 2,
  'Ann''s reply tells Ben (reply) and Pat (every message), never Ann herself');

-- ---------- the request to the game server ----------
select is((select count(*) from net.http_request_queue), 0::bigint, 'without the secret nothing was sent');
select vault.create_secret('test-secret', 'trip_push_secret');
select vault.create_secret('http://127.0.0.1:9/push/send', 'trip_push_url');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000b1", "role": "authenticated"}';
do $$ begin perform trip.send_message(current_setting('t.trip')::uuid, '@Ann see you', null, null, array[current_setting('t.ann')]::uuid[]); end $$;
reset role;
select ok((select headers ->> 'Authorization' = 'Bearer test-secret' and convert_from(body, 'utf8')::jsonb -> 'payload' ->> 'title' = 'Ben · Tokyo'
  from net.http_request_queue order by id desc limit 1), 'with it, one request goes to the game server, signed, with the text');

select * from finish();
rollback;
