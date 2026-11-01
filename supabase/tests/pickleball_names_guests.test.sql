-- Pickleball session names and guests (supabase/migrations/…_pickleball_names_guests.sql).
-- Run: supabase test db (CI's `supabase` job).
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

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

-- ---------- names ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
do $$ begin
  perform set_config('t.ann', pickleball.make_player('Ann')::text, true);
  perform set_config('t.gus', pickleball.make_player('Gus', null, true)::text, true);
  perform set_config('t.s', pickleball.start_session(null, 1, 'fair', array[current_setting('t.ann'), current_setting('t.gus')]::uuid[], 'Saturday doubles')::text, true);
  perform set_config('t.w', (select watch_code from pickleball.sessions where id = current_setting('t.s')::uuid), true);
end $$;
select is(pickleball.watch(current_setting('t.w')) ->> 'name', 'Saturday doubles', 'a session starts with its name');
select is((select name from pickleball.sessions where id = pickleball.start_session(null, 1, 'fair', '{}')), null, 'or with none (the old call)');
select lives_ok($$ select pickleball.rename_session(current_setting('t.s')::uuid, 'Sunday') $$, 'its runner renames it');
select is(pickleball.watch(current_setting('t.w')) ->> 'name', 'Sunday', 'and the live view shows the new name');
select throws_ok($$ select pickleball.rename_session(current_setting('t.s')::uuid, '<b>') $$, '23514', null, 'names refuse < > &');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
select throws_ok($$ select pickleball.rename_session(current_setting('t.s')::uuid, 'Mine') $$, 'RCPKL', null, 'another manager can''t rename it');

-- ---------- guests ----------
select ok((select guest from pickleball.players where id = current_setting('t.gus')::uuid), 'a guest is marked as one');
select ok((pickleball.watch(current_setting('t.w')) -> 'players') @> '[{"name": "Gus", "guest": true}]', 'and shown as one in the session');
select throws_ok($$ select pickleball.keep_player(current_setting('t.gus')::uuid) $$, 'RCPKL', null, 'N, who didn''t add them, can''t keep them');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select throws_ok($$ select pickleball.keep_player(current_setting('t.gus')::uuid) $$, 'RCPKL', null, 'nor can a plain account');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
do $$ begin perform pickleball.keep_player(current_setting('t.gus')::uuid); end $$;
select ok(not (select guest from pickleball.players where id = current_setting('t.gus')::uuid), 'M keeps Gus: a regular player now');
do $$ begin
  perform set_config('t.viv', pickleball.make_player('Viv', null, true)::text, true);
  perform pickleball.add_club_player(pickleball.make_club('Club'), current_setting('t.viv')::uuid);
end $$;
select ok(not (select guest from pickleball.players where id = current_setting('t.viv')::uuid), 'adding a guest to a club keeps them too');

-- ---------- my games ----------
do $$ begin perform set_config('t.code', pickleball.link_code(current_setting('t.ann')::uuid), true); end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
do $$ begin perform pickleball.link_player(current_setting('t.code')); end $$;
select is(pickleball.my_games() -> 'sessions' -> 0 ->> 'name', 'Sunday', 'my games show the session''s name');

select * from finish();
rollback;
