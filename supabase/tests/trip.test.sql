-- Trip (supabase/migrations/…_trip.sql): trips, people, joining, planners, archiving and the log.
-- Run: supabase test db (CI's `supabase` job).
begin;
create extension if not exists pgtap with schema extensions;
select plan(49);

-- S: the superuser. P and Q: accounts. A, B: anonymous sign-ins (phones that open the join link). X: an outsider.
insert into auth.users (id, aud, role, is_anonymous) values
  ('00000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000c', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000e', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-0000000000b1', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-0000000000ff', 'authenticated', 'authenticated', true);
do $$ begin perform set_config('t.first', core.first_invite(), true); end $$;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
do $$ begin
  perform core.make_account('sam', 'SSSSSSSSSSSSSSSS', current_setting('t.first'));
  perform set_config('t.p', core.make_invite(), true);
  perform set_config('t.q', core.make_invite(), true);
end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
do $$ begin perform core.make_account('pat', 'PPPPPPPPPPPPPPPP', current_setting('t.p')); end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';
do $$ begin perform core.make_account('quinn', 'QQQQQQQQQQQQQQQQ', current_setting('t.q')); end $$;

reset role;
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('trip.trips'::regclass, 'trip.people'::regclass,
  'trip.handovers'::regclass, 'trip.log'::regclass)), 'row level security is on for every table');
set local role authenticated;

-- ---------- making a trip ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
select throws_ok($$ select trip.make_trip('Tokyo', 'Ann') $$, 'RCTRP', null, 'an anonymous sign-in can''t make a trip');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select throws_ok($$ select trip.make_trip('<b>Tokyo</b>', 'Pat') $$, '23514', null, 'titles with < > & are refused');
do $$ begin perform set_config('t.trip', trip.make_trip('Tokyo', 'Pat', '🗼', '2026-12-01', '2026-12-06')::text, true); end $$;
select ok(trip.is_planner(current_setting('t.trip')::uuid), 'P makes a trip and is its planner');
select is((select home_currency from trip.trips where id = current_setting('t.trip')::uuid), 'PHP', 'in PHP by default');
select lives_ok($$ select trip.edit_trip(current_setting('t.trip')::uuid, 'Tokyo 2026', '🗼', '2026-12-01', '2026-12-07', 'PHP', 'JPY', 0.37) $$,
  'P changes the details and adds a local currency');
select throws_ok($$ select trip.edit_trip(current_setting('t.trip')::uuid, 'Tokyo', '🗼', '2026-12-08', '2026-12-01', 'PHP') $$,
  '23514', null, 'the end can''t be before the start');
select throws_ok($$ select trip.edit_trip(current_setting('t.trip')::uuid, 'Tokyo', '🗼', null, null, 'PHP', 'JPY', null) $$,
  '23514', null, 'a local currency needs its rate');
select is((select detail -> 'old' ->> 'title' || ' → ' || (detail -> 'new' ->> 'title') from trip.log
  where trip_id = current_setting('t.trip')::uuid and action = 'trip.edit'), 'Tokyo → Tokyo 2026', 'the edit is logged with old and new values');

-- ---------- people ----------
do $$ begin
  perform set_config('t.ann', trip.add_person(current_setting('t.trip')::uuid, 'Ann', '🦊')::text, true);
  perform set_config('t.ben', trip.add_person(current_setting('t.trip')::uuid, 'Ben')::text, true);
  perform set_config('t.code', trip.join_link(current_setting('t.trip')::uuid), true);
end $$;
select throws_ok($$ select trip.add_person(current_setting('t.trip')::uuid, 'ann') $$, 'RCTRP', null, 'names are unique on a trip');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
select throws_ok($$ select trip.add_person(current_setting('t.trip')::uuid, 'Cy') $$, 'RCTRP', null, 'only planners add people');
select throws_ok($$ select trip.join_link(current_setting('t.trip')::uuid) $$, 'RCTRP', null, 'only planners see the join code');

-- ---------- joining ----------
set local role anon;
select is(jsonb_array_length(trip.join_info(current_setting('t.code')) -> 'people'), 3, 'the join link shows the names, signed out too');
select is(trip.join_info('ZZZZZZZZZZZZZZZZ'), null, 'a wrong code shows nothing');
select throws_ok($$ select * from trip.trips $$, '42501', null, 'signed out, the tables aren''t readable');
set local role authenticated;
select is(trip.claim(current_setting('t.code'), current_setting('t.ann')::uuid)::text, current_setting('t.trip'), 'A claims Ann');
select is(trip.me(current_setting('t.trip')::uuid)::text, current_setting('t.ann'), 'A is Ann on the trip');
select ok(not trip.is_planner(current_setting('t.trip')::uuid), 'and not a planner');
select throws_ok($$ select trip.claim(current_setting('t.code'), current_setting('t.ben')::uuid) $$, 'RCTRP', null,
  'A can''t be two people on a trip');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000b1", "role": "authenticated"}';
select throws_ok($$ select trip.claim(current_setting('t.code'), current_setting('t.ann')::uuid) $$, 'RCTRP', null,
  'B can''t take a taken name');
select ok(trip.claim(current_setting('t.code'), current_setting('t.ben')::uuid) is not null, 'B claims Ben');
select lives_ok($$ select trip.release(current_setting('t.trip')::uuid) $$, 'B lets Ben go');
select is((select (x ->> 'taken')::boolean from jsonb_array_elements(trip.join_info(current_setting('t.code')) -> 'people') x
  where x ->> 'name' = 'Ben'), false, 'Ben is free again');
select ok(not trip.is_member(current_setting('t.trip')::uuid), 'and B is off the trip');

-- ---------- what each reads ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
select is((select count(*) from trip.trips), 1::bigint, 'A reads the trip');
select is((select count(*) from trip.people), 3::bigint, 'and its people');
select throws_ok($$ select join_code from trip.trips $$, '42501', null, 'but not the join code');
select throws_ok($$ select user_id from trip.people $$, '42501', null, 'or who claimed which name');
select is((select count(*) from trip.log), 0::bigint, 'or the log (planners only)');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000ff", "role": "authenticated"}';
select is((select count(*) from trip.trips) + (select count(*) from trip.people), 0::bigint, 'X, not on the trip, reads nothing');
select throws_ok($$ insert into trip.log (trip_id, actor, action) values (current_setting('t.trip')::uuid, auth.uid(), 'x') $$,
  '42501', null, 'nobody writes the log');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select ok((select count(*) from trip.log where action = 'person.claim') = 2, 'P, a planner, reads the log: both claims');
select throws_ok($$ delete from trip.log $$, '42501', null, 'and can''t delete it');

-- ---------- editing names ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
select lives_ok($$ select trip.edit_person(current_setting('t.ann')::uuid, 'Annie', '🦊') $$, 'Ann renames herself');
select throws_ok($$ select trip.edit_person(current_setting('t.ben')::uuid, 'Benny') $$, 'RCTRP', null, 'but not Ben');

-- ---------- linking an account (hand-over code) ----------
do $$ begin perform set_config('t.hand', trip.handover_code(current_setting('t.trip')::uuid), true); end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';
select is(trip.take_over(current_setting('t.hand'))::text, current_setting('t.trip'), 'Q signs in and takes over Ann');
select is(trip.me(current_setting('t.trip')::uuid)::text, current_setting('t.ann'), 'Q is Ann now');
select throws_ok($$ select trip.take_over(current_setting('t.hand')) $$, 'RCTRP', null, 'a hand-over code works once');
select is(jsonb_array_length(trip.my_trips()), 1, 'the trip is in Q''s trips');

-- ---------- planners ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select throws_ok($$ select trip.set_planner(current_setting('t.ben')::uuid, true) $$, 'RCTRP', null, 'a planner needs an account');
select lives_ok($$ select trip.set_planner(current_setting('t.ann')::uuid, true) $$, 'P makes Ann (Q) a planner');
select throws_ok($$ select trip.remove_person(current_setting('t.ann')::uuid) $$, 'RCTRP', null, 'a planner can''t be removed');

-- ---------- freeing a name ----------
select lives_ok($$ select trip.free_person(current_setting('t.ann')::uuid) $$, 'P frees Ann''s device (lost phone)');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
select ok(not trip.is_member(current_setting('t.trip')::uuid), 'A''s phone is off the trip');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';
select ok(trip.is_planner(current_setting('t.trip')::uuid), 'Q''s account still is Ann, and a planner');

-- ---------- archiving and new codes ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select lives_ok($$ select trip.archive_trip(current_setting('t.trip')::uuid, true) $$, 'P archives the trip');
select throws_ok($$ select trip.add_person(current_setting('t.trip')::uuid, 'Cy') $$, 'RCTRP', null, 'archived, nothing changes');
select lives_ok($$ select trip.archive_trip(current_setting('t.trip')::uuid, false) $$, 'P brings it back');
do $$ begin perform trip.new_join_code(current_setting('t.trip')::uuid); end $$;
select is(trip.join_info(current_setting('t.code')), null, 'a new join code: the old link stops working');

select * from finish();
rollback;
