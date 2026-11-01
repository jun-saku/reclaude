-- Pickleball (supabase/migrations/…_pickleball.sql): managers, players, clubs, sessions, helpers and the live view.
-- Run: supabase test db (CI's `supabase` job).
begin;
create extension if not exists pgtap with schema extensions;
select plan(63);

-- S: the superuser. M and N: pickleball managers. P: a plain account. H: an anonymous sign-in (a helper at the courts).
insert into auth.users (id, aud, role, is_anonymous) values
  ('00000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000a', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000b', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000c', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-0000000000dd', 'authenticated', 'authenticated', true);
do $$ begin perform set_config('t.first', core.first_invite(), true); end $$;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
do $$ begin
  perform core.make_account('sam', 'SSSSSSSSSSSSSSSS', current_setting('t.first'));
  perform set_config('t.m', core.make_invite(), true);
  perform set_config('t.n', core.make_invite(), true);
  perform set_config('t.p', core.make_invite(), true);
end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
do $$ begin perform core.make_account('meg', 'MMMMMMMMMMMMMMMM', current_setting('t.m')); end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
do $$ begin perform core.make_account('ned', 'NNNNNNNNNNNNNNNN', current_setting('t.n')); end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
do $$ begin perform core.make_account('pat', 'PPPPPPPPPPPPPPPP', current_setting('t.p')); end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
do $$ begin
  perform core.give_app_role('00000000-0000-0000-0000-00000000000a', 'pickleball', 'manager');
  perform core.give_app_role('00000000-0000-0000-0000-00000000000b', 'pickleball', 'manager');
end $$;

reset role;
select ok((select bool_and(relrowsecurity) from pg_class where relnamespace = 'pickleball'::regnamespace and relkind = 'r'),
  'row level security is on for every pickleball table');
select is((select count(*) from core.app_role_names where app = 'pickleball'), 1::bigint, 'pickleball has one role: manager');
set local role authenticated;

-- ---------- players and clubs ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select ok(not pickleball.is_manager(), 'P is no manager');
select throws_ok($$ select pickleball.make_player('Pat') $$, 'RCPKL', null, 'P cannot add players');
select throws_ok($$ select pickleball.make_club('Club') $$, 'RCPKL', null, 'or clubs');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select ok(pickleball.is_manager(), 'M is a manager');
do $$ begin
  perform set_config('t.a', pickleball.make_player('Ann')::text, true);
  perform set_config('t.b', pickleball.make_player('Ben', '🦊')::text, true);
  perform set_config('t.c', pickleball.make_player('Cat')::text, true);
  perform set_config('t.d', pickleball.make_player('Dan')::text, true);
  perform set_config('t.e', pickleball.make_player('Eve')::text, true);
  perform set_config('t.club', pickleball.make_club('Tuesdays')::text, true);
end $$;
select is((select icon from pickleball.players where name = 'Ann'), '👤', 'a player''s icon is 👤 by default');
select is((select icon from pickleball.players where name = 'Ben'), '🦊', 'or the one given');
select throws_ok($$ select pickleball.make_player('<b>') $$, '23514', null, 'names refuse < > &');
select throws_ok($$ insert into pickleball.players (name, made_by) values ('Sly', '00000000-0000-0000-0000-00000000000a') $$,
  '42501', null, 'tables change only through the functions');
select is((select array_agg(user_id) from pickleball.club_managers where club_id = current_setting('t.club')::uuid),
  array['00000000-0000-0000-0000-00000000000a'::uuid], 'a club''s maker manages it');
select lives_ok($$ select pickleball.add_club_player(current_setting('t.club')::uuid, current_setting('t.a')::uuid);
  select pickleball.add_club_player(current_setting('t.club')::uuid, current_setting('t.b')::uuid);
  select pickleball.add_club_player(current_setting('t.club')::uuid, current_setting('t.a')::uuid) $$, 'M adds players (twice is fine)');
select is((select count(*) from pickleball.club_players where club_id = current_setting('t.club')::uuid), 2::bigint, 'the club has two players');
select throws_ok($$ select pickleball.add_club_manager(current_setting('t.club')::uuid, '00000000-0000-0000-0000-00000000000c') $$,
  'RCPKL', null, 'only accounts with the manager role can manage a club');
select throws_ok($$ select pickleball.remove_club_manager(current_setting('t.club')::uuid, '00000000-0000-0000-0000-00000000000a') $$,
  'RCPKL', null, 'a club keeps at least one manager');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
select is((select count(*) from pickleball.players), 5::bigint, 'every manager sees every player');
select throws_ok($$ select pickleball.rename_club(current_setting('t.club')::uuid, 'Mine') $$, 'RCPKL', null,
  'N cannot change a club N doesn''t manage');
select throws_ok($$ select pickleball.edit_player(current_setting('t.a')::uuid, 'Anna') $$, 'RCPKL', null,
  'or a player N didn''t add, in no club of N''s');
select throws_ok($$ select pickleball.start_session(current_setting('t.club')::uuid, 2, 'fair', '{}') $$, 'RCPKL', null,
  'or start a session for that club');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select lives_ok($$ select pickleball.add_club_manager(current_setting('t.club')::uuid, '00000000-0000-0000-0000-00000000000b') $$,
  'M makes N a manager of the club');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
select lives_ok($$ select pickleball.edit_player(current_setting('t.a')::uuid, 'Anna', '🐻') $$, 'now N edits the club''s players');
select is((select name || icon from pickleball.players where id = current_setting('t.a')::uuid), 'Anna🐻', 'and it''s changed');
select lives_ok($$ select pickleball.remove_club_manager(current_setting('t.club')::uuid, '00000000-0000-0000-0000-00000000000a') $$,
  'and could remove M');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
select throws_ok($$ select pickleball.rename_club(current_setting('t.club')::uuid, 'Mine') $$, 'RCPKL', null,
  'a superuser is a manager, but not of every club');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
do $$ begin perform pickleball.add_club_manager(current_setting('t.club')::uuid, '00000000-0000-0000-0000-00000000000a'); end $$;

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select is((select count(*) from pickleball.players) + (select count(*) from pickleball.clubs), 0::bigint,
  'P reads no players or clubs');
select is((select count(*) from pickleball.managers()), 0::bigint, 'or managers');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
select is((select array_agg(username order by username) from pickleball.managers()), array['meg', 'ned', 'sam'],
  'managers see who can manage: the managers and the superuser');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
do $$ begin perform core.set_active('00000000-0000-0000-0000-00000000000b', false); end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select is((select array_agg(username order by username) from pickleball.managers()), array['meg', 'sam'],
  'but not deactivated accounts');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
do $$ begin perform core.set_active('00000000-0000-0000-0000-00000000000b', true); end $$;

-- ---------- a session ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
do $$ begin
  perform set_config('t.s', pickleball.start_session(current_setting('t.club')::uuid, 2, 'fair',
    array[current_setting('t.a'), current_setting('t.b'), current_setting('t.c'), current_setting('t.d')]::uuid[])::text, true);
end $$;
select is((select count(*) from pickleball.session_players where session_id = current_setting('t.s')::uuid and here), 4::bigint,
  'M starts a session with four players here');
select lives_ok($$ select pickleball.start_match(current_setting('t.s')::uuid, 1,
  array[current_setting('t.a'), current_setting('t.b')]::uuid[], array[current_setting('t.c'), current_setting('t.d')]::uuid[]) $$,
  'and puts a doubles match on court 1');
select throws_ok($$ select pickleball.start_match(current_setting('t.s')::uuid, 2,
  array[current_setting('t.a')]::uuid[], array[current_setting('t.e')]::uuid[]) $$, 'RCPKL', null, 'nobody plays on two courts');
select throws_ok($$ select pickleball.start_match(current_setting('t.s')::uuid, 2,
  array[current_setting('t.e')]::uuid[], array[current_setting('t.e')]::uuid[]) $$, 'RCPKL', null, 'or against themselves');
select throws_ok($$ select pickleball.start_match(current_setting('t.s')::uuid, 2,
  array[current_setting('t.e')]::uuid[], null) $$, 'RCPKL', null, 'each side has a player');
select throws_ok($$ select pickleball.start_match(current_setting('t.s')::uuid, 3,
  array[current_setting('t.e')]::uuid[], array[current_setting('t.a')]::uuid[]) $$, 'RCPKL', null, 'there''s no court 3');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
do $$ begin
  perform set_config('t.g', pickleball.make_player('Gus')::text, true);
  perform pickleball.set_here(current_setting('t.s')::uuid, current_setting('t.e')::uuid, true);
  perform pickleball.set_here(current_setting('t.s')::uuid, current_setting('t.g')::uuid, true);
end $$;
select is((select count(*) from pickleball.session_players where session_id = current_setting('t.s')::uuid and here), 6::bigint,
  'N (a club manager) adds Eve and a guest');
select lives_ok($$ select pickleball.start_match(current_setting('t.s')::uuid, 2,
  array[current_setting('t.e')]::uuid[], array[current_setting('t.g')]::uuid[]) $$, 'a singles match on court 2');
select throws_ok($$ select pickleball.set_session(current_setting('t.s')::uuid, 1, 'fair') $$, 'RCPKL', null,
  'a court in use can''t be removed');
select lives_ok($$ select pickleball.set_session(current_setting('t.s')::uuid, 3, 'winners_stay') $$, 'N changes the settings');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
do $$ begin
  perform set_config('t.m1', (select id::text from pickleball.matches where session_id = current_setting('t.s')::uuid and court = 1), true);
end $$;
select throws_ok($$ select pickleball.end_match(current_setting('t.m1')::bigint, 11, null) $$, 'RCPKL', null,
  'a score has both sides');
select lives_ok($$ select pickleball.end_match(current_setting('t.m1')::bigint, 11, 7) $$, 'M ends the match with its score');
select ok((select ended_at is not null and score_a = 11 and score_b = 7 from pickleball.matches
  where id = current_setting('t.m1')::bigint), 'it''s ended, with the time and the score');

-- ---------- helpers ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000dd", "role": "authenticated"}';
select throws_ok($$ select pickleball.save_state(current_setting('t.s')::uuid, 0, '{}', 'moved') $$, 'RCPKL', null,
  'H can''t change the queue');
select throws_ok($$ select pickleball.helper_code(current_setting('t.s')::uuid) $$, 'RCPKL', null, 'or make a helper code');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
do $$ begin perform set_config('t.code', pickleball.helper_code(current_setting('t.s')::uuid), true); end $$;
select is((select count(*) from pickleball.log where session_id = current_setting('t.s')::uuid and action = 'new helper code'),
  1::bigint, 'M makes one, and it''s in the session''s log');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000dd", "role": "authenticated"}';
select throws_ok($$ select pickleball.become_helper(current_setting('t.s')::uuid, 'ZZZZZZZZZZZZZZZZ') $$, 'RCPKL', null,
  'a wrong code doesn''t work');
do $$ begin perform set_config('t.watch', pickleball.become_helper(current_setting('t.s')::uuid, current_setting('t.code')), true); end $$;
select is((pickleball.watch(current_setting('t.watch')) ->> 'id'), current_setting('t.s'), 'the right one does, and gives the live view');
do $$ begin perform set_config('t.v', pickleball.watch(current_setting('t.watch')) ->> 'version', true); end $$;
select is(pickleball.save_state(current_setting('t.s')::uuid, current_setting('t.v')::int, '{"queue": [1]}', 'skipped',
  '{"player": "x"}'), current_setting('t.v')::int + 1, 'H saves the queue');
select throws_ok($$ select pickleball.save_state(current_setting('t.s')::uuid, current_setting('t.v')::int, '{}', 'moved') $$,
  'RCPKL', null, 'but not over a newer version');
select throws_ok($$ select pickleball.set_here(current_setting('t.s')::uuid, current_setting('t.a')::uuid, false) $$, 'RCPKL', null,
  'helpers don''t change who''s in the session');
select lives_ok($$ select pickleball.start_match(current_setting('t.s')::uuid, 1,
  array[current_setting('t.a'), current_setting('t.c')]::uuid[], array[current_setting('t.b'), current_setting('t.d')]::uuid[]) $$,
  'H puts the next match on court 1');
select is((select count(*) from pickleball.sessions) + (select count(*) from pickleball.log), 0::bigint,
  'H reads no tables, only the live view');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
do $$ begin perform pickleball.helper_code(current_setting('t.s')::uuid); end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000dd", "role": "authenticated"}';
select throws_ok($$ select pickleball.save_state(current_setting('t.s')::uuid, 0, '{}', 'moved') $$, 'RCPKL', null,
  'a new code drops the old helpers');

-- ---------- the live view ----------
set local role anon;
set local request.jwt.claims = '{"role": "anon"}';
select is(jsonb_array_length(pickleball.watch(current_setting('t.watch')) -> 'players'), 6, 'anyone with the link sees who''s here');
select is(jsonb_array_length(pickleball.watch(current_setting('t.watch')) -> 'matches'), 3, 'and the matches');
select ok(not (pickleball.watch(current_setting('t.watch')) ?| array['helper_hash', 'watch_code', 'started_by']),
  'but no codes or managers');
select is(pickleball.watch('ZZZZZZZZZZZZZZZZ'), null, 'a wrong link shows nothing');
select throws_ok($$ select count(*) from pickleball.sessions $$, '42501', null, 'and visitors read no tables');
select throws_ok($$ select pickleball.make_player('Viv') $$, '42501', null, 'or change anything');

-- ---------- the log and the end ----------
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select is((select count(*) from pickleball.log), 0::bigint, 'P reads no log');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select ok((select count(*) from pickleball.log where session_id = current_setting('t.s')::uuid and action = 'skipped'
  and actor = '00000000-0000-0000-0000-0000000000dd') = 1, 'the runner sees who did what, helpers too');
select lives_ok($$ select pickleball.end_session(current_setting('t.s')::uuid) $$, 'M ends the session');
select is((select count(*) from pickleball.matches where session_id = current_setting('t.s')::uuid and ended_at is null),
  0::bigint, 'and its matches');
select throws_ok($$ select pickleball.start_match(current_setting('t.s')::uuid, 1,
  array[current_setting('t.a')]::uuid[], array[current_setting('t.b')]::uuid[]) $$, 'RCPKL', null, 'an ended session is over');

select * from finish();
rollback;
