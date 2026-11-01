-- Pickleball account links (supabase/migrations/…_pickleball_links.sql): link codes, linking, unlinking, my_games.
-- Run: supabase test db (CI's `supabase` job).
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

-- S: the superuser. M and N: pickleball managers. P and Q: plain accounts (players). H: an anonymous sign-in.
insert into auth.users (id, aud, role, is_anonymous) values
  ('00000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000a', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000b', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000c', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000e', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-0000000000dd', 'authenticated', 'authenticated', true);
do $$ begin perform set_config('t.first', core.first_invite(), true); end $$;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
do $$ begin
  perform core.make_account('sam', 'SSSSSSSSSSSSSSSS', current_setting('t.first'));
  perform set_config('t.m', core.make_invite(), true);
  perform set_config('t.n', core.make_invite(), true);
  perform set_config('t.p', core.make_invite(), true);
  perform set_config('t.q', core.make_invite(), true);
end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
do $$ begin perform core.make_account('meg', 'MMMMMMMMMMMMMMMM', current_setting('t.m')); end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
do $$ begin perform core.make_account('ned', 'NNNNNNNNNNNNNNNN', current_setting('t.n')); end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
do $$ begin perform core.make_account('pat', 'PPPPPPPPPPPPPPPP', current_setting('t.p')); end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';
do $$ begin perform core.make_account('quinn', 'QQQQQQQQQQQQQQQQ', current_setting('t.q')); end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
do $$ begin
  perform core.give_app_role('00000000-0000-0000-0000-00000000000a', 'pickleball', 'manager');
  perform core.give_app_role('00000000-0000-0000-0000-00000000000b', 'pickleball', 'manager');
end $$;

-- M adds Ann and Ben, runs a session: Ann beats Ben 11–5, then they play again without a score.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
do $$
declare s uuid; m bigint;
begin
  perform set_config('t.ann', pickleball.make_player('Ann', '🦊')::text, true);
  perform set_config('t.ben', pickleball.make_player('Ben')::text, true);
  s := pickleball.start_session(null, 1, 'queue', array[current_setting('t.ann'), current_setting('t.ben')]::uuid[]);
  m := pickleball.start_match(s, 1, array[current_setting('t.ann')]::uuid[], array[current_setting('t.ben')]::uuid[]);
  perform pickleball.end_match(m, 11, 5);
  m := pickleball.start_match(s, 1, array[current_setting('t.ben')]::uuid[], array[current_setting('t.ann')]::uuid[]);
  perform pickleball.end_match(m);
end $$;

reset role;
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('pickleball.player_links'::regclass, 'pickleball.link_codes'::regclass)),
  'row level security is on for links and codes');
set local role authenticated;

-- ---------- codes ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select throws_ok($$ select pickleball.link_code(current_setting('t.ann')::uuid) $$, 'RCPKL', null, 'P (no manager) can''t make a link code');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
select throws_ok($$ select pickleball.link_code(current_setting('t.ann')::uuid) $$, 'RCPKL', null,
  'or N, a manager who didn''t add Ann and manages no club of hers');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
do $$ begin perform set_config('t.code', pickleball.link_code(current_setting('t.ann')::uuid), true); end $$;
select is(length(current_setting('t.code')), 16, 'M makes a code for Ann');

-- ---------- linking ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000dd", "role": "authenticated"}';
select throws_ok($$ select pickleball.link_player(current_setting('t.code')) $$, 'RCPKL', null, 'an anonymous sign-in can''t link');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select throws_ok($$ select pickleball.link_player('ZZZZZZZZZZZZZZZZ') $$, 'RCPKL', null, 'a wrong code doesn''t work');
select is(pickleball.link_player(current_setting('t.code')) ->> 'name', 'Ann', 'P links with the code: P is Ann');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';
select throws_ok($$ select pickleball.link_player(current_setting('t.code')) $$, 'RCPKL', null, 'a code works once');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select throws_ok($$ select pickleball.link_code(current_setting('t.ann')::uuid) $$, 'RCPKL', null, 'a linked player gets no new code');

-- ---------- what each sees ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select is(pickleball.my_games() -> 'players' -> 0 ->> 'name', 'Ann', 'P sees their player');
select is((pickleball.my_games() -> 'players' -> 0 ->> 'matches')::int, 2, 'with the matches played');
select is((pickleball.my_games() -> 'players' -> 0 ->> 'wins')::int, 1, 'and won (scored ones)');
select is(jsonb_array_length(pickleball.my_games() -> 'sessions'), 1, 'and the session they played in, with its link');
select throws_ok($$ select count(*) from pickleball.player_links $$, '42501', null, 'links are read only through the functions');
select is((select count(*) from pickleball.links()), 0::bigint, 'P doesn''t see who else is linked');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';
select is(jsonb_array_length(pickleball.my_games() -> 'players'), 0, 'Q has no players');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
select is((select username from pickleball.links() where player_id = current_setting('t.ann')::uuid), 'pat',
  'managers see who a player is linked to');

-- ---------- unlinking and old codes ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';
select throws_ok($$ select pickleball.unlink_player(current_setting('t.ann')::uuid) $$, 'RCPKL', null, 'Q can''t unlink Ann');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
do $$ begin perform pickleball.unlink_player(current_setting('t.ann')::uuid); end $$;
select is(jsonb_array_length(pickleball.my_games() -> 'players'), 0, 'P unlinks themselves');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
do $$ begin perform set_config('t.old', pickleball.link_code(current_setting('t.ben')::uuid), true); end $$;
reset role;
update pickleball.link_codes set expires_at = now() - interval '1 minute' where player_id = current_setting('t.ben')::uuid;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select throws_ok($$ select pickleball.link_player(current_setting('t.old')) $$, 'RCPKL', null, 'a code over a week old doesn''t work');

select * from finish();
rollback;
