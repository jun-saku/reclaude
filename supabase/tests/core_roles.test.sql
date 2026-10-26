-- Roles from the admin panel: core roles (set_role, remove_role: superusers) and project roles (give_app_role,
-- remove_app_role: admins and superusers), never your own. Run: supabase test db (CI's `supabase` job).
begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

-- A project with its own roles, as its migration would add them.
insert into core.apps (name, title) values ('pickleball', 'Pickleball');
insert into core.app_role_names (app, role, title) values
  ('pickleball', 'organiser', 'Organiser'), ('pickleball', 'scorekeeper', 'Scorekeeper');

-- S becomes the superuser and invites A, B and C (plain accounts).
insert into auth.users (id, aud, role, is_anonymous) values
  ('00000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000a', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000b', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000c', 'authenticated', 'authenticated', true);
do $$ begin perform set_config('t.first', core.first_invite(), true); end $$;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
do $$ begin perform core.make_account('sam', 'SSSSSSSSSSSSSSSS', current_setting('t.first')); end $$;
do $$ begin
  perform set_config('t.a', core.make_invite(), true);
  perform set_config('t.b', core.make_invite(), true);
  perform set_config('t.c', core.make_invite(), true);
end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
do $$ begin perform core.make_account('ada', 'AAAAAAAAAAAAAAAA', current_setting('t.a')); end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
do $$ begin perform core.make_account('bob', 'BBBBBBBBBBBBBBBB', current_setting('t.b')); end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
do $$ begin perform core.make_account('cyd', 'CCCCCCCCCCCCCCCC', current_setting('t.c')); end $$;

select is((select count(*) from core.apps), 1::bigint, 'anyone signed in reads the projects');
select is((select count(*) from core.app_role_names), 2::bigint, 'and their roles');
select ok(not core.has_app_role('pickleball', 'organiser'), 'C has no project role');
select is((select count(*) from core.accounts), 1::bigint, 'a plain account sees only itself');

-- Plain accounts can't give roles.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
select throws_ok($$ select core.set_role('00000000-0000-0000-0000-00000000000b', 'superuser') $$, '42501', null, 'a plain account cannot give itself a core role');
select throws_ok($$ select core.give_app_role('00000000-0000-0000-0000-00000000000c', 'pickleball', 'organiser') $$, '42501', null,
  'nor anyone a project role');
select throws_ok($$ insert into core.app_roles (user_id, app, role) values ('00000000-0000-0000-0000-00000000000b', 'pickleball', 'organiser') $$,
  '42501', null, 'nor write roles directly');

-- Core roles: superusers only, never their own.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
select lives_ok($$ select core.set_role('00000000-0000-0000-0000-00000000000a', 'admin') $$, 'S makes A a core admin');
select throws_ok($$ select core.set_role('00000000-0000-0000-0000-00000000000a', 'organiser') $$, '23514', null, 'core roles are admin or superuser');
select throws_ok($$ select core.set_role('00000000-0000-0000-0000-000000000005', 'admin') $$, '42501', null, 'S cannot change their own roles');
select throws_ok($$ select core.remove_role('00000000-0000-0000-0000-000000000005') $$, '42501', null, 'so S stays a superuser');
select throws_ok($$ select core.set_role('00000000-0000-0000-0000-0000000000ff', 'admin') $$, 'P0002', null, 'no role for an account that isn''t there');
select throws_ok($$ insert into core.roles (user_id, role, scope) values ('00000000-0000-0000-0000-00000000000b', 'admin', 'pickleball') $$,
  '42501', null, 'core roles are written only by these functions');

-- A (core admin): sees every account, gives and takes project roles, but no core roles.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select ok(core.is_admin() and not core.is_superuser(), 'A is an admin');
select is((select count(*) from core.accounts), 4::bigint, 'an admin sees every account');
select throws_ok($$ select core.set_role('00000000-0000-0000-0000-00000000000b', 'admin') $$, '42501', null, 'an admin cannot give core roles');
select throws_ok($$ select core.set_active('00000000-0000-0000-0000-00000000000b', false) $$, '42501', null, 'nor change accounts');
select lives_ok($$ select core.give_app_role('00000000-0000-0000-0000-00000000000b', 'pickleball', 'organiser') $$, 'A makes B an organiser');
select lives_ok($$ select core.give_app_role('00000000-0000-0000-0000-00000000000b', 'pickleball', 'scorekeeper') $$, 'and a scorekeeper (several roles)');
select lives_ok($$ select core.give_app_role('00000000-0000-0000-0000-00000000000b', 'pickleball', 'organiser') $$, 'giving it again is fine');
select throws_ok($$ select core.give_app_role('00000000-0000-0000-0000-00000000000b', 'pickleball', 'referee') $$, 'P0002', null, 'only the project''s own roles');
select throws_ok($$ select core.give_app_role('00000000-0000-0000-0000-00000000000b', 'chess', 'organiser') $$, 'P0002', null, 'only projects that exist');
select throws_ok($$ select core.give_app_role('00000000-0000-0000-0000-00000000000a', 'pickleball', 'organiser') $$, '42501', null, 'A cannot give themselves one');
select is((select count(*) from core.app_roles), 2::bigint, 'an admin sees everyone''s project roles');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
select ok(core.has_app_role('pickleball', 'organiser') and core.has_app_role('pickleball', 'scorekeeper'), 'B holds both roles');
select ok(not core.is_admin() and not core.has_role('admin'), 'project roles aren''t core roles');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select is((select count(*) from core.app_roles), 0::bigint, 'others see only their own project roles');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select lives_ok($$ select core.remove_app_role('00000000-0000-0000-0000-00000000000b', 'pickleball', 'scorekeeper') $$, 'A takes one away');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
select ok(core.has_app_role('pickleball', 'organiser') and not core.has_app_role('pickleball', 'scorekeeper'), 'B keeps the other');

-- A superuser holds every project role; a deactivated account holds none.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
select ok(core.has_app_role('pickleball', 'scorekeeper'), 'a superuser passes every project role check');
select lives_ok($$ select core.set_active('00000000-0000-0000-0000-00000000000b', false) $$, 'S deactivates B');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
select ok(not core.has_app_role('pickleball', 'organiser'), 'a deactivated account holds no project role');
reset role;
select is((select array_agg((detail ->> 'app') || ' ' || (detail ->> 'role') || ' ' || action order by id) from core.audit
  where action in ('gave role', 'removed role')),
  array['core admin gave role', 'pickleball organiser gave role', 'pickleball scorekeeper gave role', 'pickleball scorekeeper removed role'],
  'each change is in the audit log (giving the same role twice once)');

select * from finish();
rollback;
