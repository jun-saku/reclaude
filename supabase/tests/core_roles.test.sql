-- core roles from the admin panel: set_role and remove_role, superusers only, never their own.
-- Run: supabase test db (CI's `supabase` job).
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

-- S becomes the superuser, then invites A and B (plain accounts).
insert into auth.users (id, aud, role, is_anonymous) values
  ('00000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000a', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000b', 'authenticated', 'authenticated', true);
do $$ begin perform set_config('t.first', core.first_invite(), true); end $$;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
do $$ begin perform core.make_account('sam', 'SSSSSSSSSSSSSSSS', current_setting('t.first')); end $$;
do $$ begin perform set_config('t.a', core.make_invite(), true); perform set_config('t.b', core.make_invite(), true); end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
do $$ begin perform core.make_account('ada', 'AAAAAAAAAAAAAAAA', current_setting('t.a')); end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
do $$ begin perform core.make_account('bob', 'BBBBBBBBBBBBBBBB', current_setting('t.b')); end $$;

-- B (no role) can't give or take roles.
select throws_ok($$ select core.set_role('00000000-0000-0000-0000-00000000000b', 'superuser') $$, '42501', null, 'a plain account cannot give itself a role');
select throws_ok($$ select core.set_role('00000000-0000-0000-0000-00000000000a', 'admin', 'pickleball') $$, '42501', null, 'nor anyone else one');

-- S gives A admin of pickleball, then of every app, then takes pickleball away.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
select lives_ok($$ select core.set_role('00000000-0000-0000-0000-00000000000a', 'admin', 'pickleball') $$, 'S makes A an admin of pickleball');
select throws_ok($$ select core.set_role('00000000-0000-0000-0000-00000000000a', 'user', 'pickleball') $$, '23514', null, 'only real roles');
select throws_ok($$ select core.set_role('00000000-0000-0000-0000-00000000000a', 'superuser', 'pickleball') $$, '22023', null, 'a superuser is for every app');
select throws_ok($$ select core.set_role('00000000-0000-0000-0000-00000000000a', 'admin', 'Pickle Ball') $$, '23514', null, 'an app is a schema name');
select throws_ok($$ select core.set_role('00000000-0000-0000-0000-000000000005', 'admin', 'pickleball') $$, '42501', null, 'S cannot change their own roles');
select throws_ok($$ select core.remove_role('00000000-0000-0000-0000-000000000005') $$, '42501', null, 'so S stays a superuser');
select throws_ok($$ select core.set_role('00000000-0000-0000-0000-0000000000ff', 'admin') $$, 'P0002', null, 'no role for an account that isn''t there');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select ok(core.has_role('admin', 'pickleball') and not core.has_role('admin', 'plan'), 'A is an admin of pickleball only');
select throws_ok($$ select core.set_role('00000000-0000-0000-0000-00000000000b', 'admin', 'pickleball') $$, '42501', null, 'an admin cannot give roles');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
select lives_ok($$ select core.set_role('00000000-0000-0000-0000-00000000000a', 'admin', '') $$, 'S makes A an admin of every app (no app = every app)');
select lives_ok($$ select core.set_role('00000000-0000-0000-0000-00000000000a', 'admin', '*') $$, 'giving the same role again is fine');
select lives_ok($$ select core.remove_role('00000000-0000-0000-0000-00000000000a', 'pickleball') $$, 'S takes away A''s pickleball role');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select ok(core.has_role('admin', 'plan') and core.has_role('admin', 'pickleball'), 'A is still an admin everywhere (the * role)');

-- A second superuser, who can then manage S.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
select lives_ok($$ select core.set_role('00000000-0000-0000-0000-00000000000b', 'superuser') $$, 'S makes B a superuser');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
select ok(core.is_superuser(), 'B is a superuser');
select lives_ok($$ select core.remove_role('00000000-0000-0000-0000-00000000000a', '*') $$, 'B takes away A''s role');
reset role;
select is((select count(*) from core.roles where user_id = '00000000-0000-0000-0000-00000000000a'), 0::bigint, 'A has no role left');
select is((select array_agg(action || ' ' || (detail ->> 'role') || ' ' || (detail ->> 'scope') order by id) from core.audit
  where action in ('gave role', 'removed role')),
  array['gave role admin pickleball', 'gave role admin *', 'removed role admin pickleball', 'gave role superuser *', 'removed role admin *'],
  'each change is in the audit log (giving the same role twice once)');

select * from finish();
rollback;
