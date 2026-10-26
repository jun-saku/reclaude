-- core invites: one code per person, readable while pending, with a note; who can make, see and cancel them.
-- Run: supabase test db (CI's `supabase` job).
begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

-- Anonymous sign-ins: S (becomes the superuser), A (an admin), U (a plain account), N and M (new people).
insert into auth.users (id, aud, role, is_anonymous) values
  ('00000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000a', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000e', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000f', 'authenticated', 'authenticated', true);

do $$ begin perform set_config('t.first', core.first_invite(), true); end $$;
select is((select code from core.invites where note = 'first superuser'), current_setting('t.first'), 'the first invite''s code is readable in the SQL editor');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
select lives_ok($$ select core.make_account('sam', 'SSSSSSSSSSSSSSSS', current_setting('t.first')) $$, 'S becomes the superuser');
reset role;
select is((select code from core.invites where note = 'first superuser'), null, 'a used invite''s code is cleared');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
do $$ begin perform set_config('t.admin', core.make_invite('admin'), true); end $$;
do $$ begin perform set_config('t.user', core.make_invite(note => 'for Uma'), true); end $$;
select is((select code from core.invites where note = 'for Uma'), current_setting('t.user'), 'the superuser can read a pending invite''s code');
select throws_ok($$ select core.make_invite(note => '<b>x</b>') $$, '23514', null, 'notes with < > & are refused');
select throws_ok($$ select core.make_invite(note => repeat('x', 61)) $$, '23514', null, 'notes are at most 60 characters');
select ok(core.make_invite(note => '  ') is not null, 'a blank note is no note');
select throws_ok($$ select core.make_invite('user') $$, '23514', null, 'there is no "user" role (a plain account is one)');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select lives_ok($$ select core.make_account('ada', 'AAAAAAAAAAAAAAAA', current_setting('t.admin')) $$, 'A joins as an admin');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000001", "role": "authenticated"}';
select lives_ok($$ select core.make_account('uma', 'VVVVVVVVVVVVVVVV', current_setting('t.user')) $$, 'U joins with a plain invite');

-- Anonymous users and plain accounts can't make or see invites.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';
select ok(not core.is_admin(), 'an anonymous user is no admin');
select throws_ok($$ select core.make_invite() $$, '42501', null, 'an anonymous user cannot make invites');
select is((select count(*) from core.invites), 0::bigint, 'nor see any');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000001", "role": "authenticated"}';
select ok(not core.is_admin(), 'a plain account is no admin');
select throws_ok($$ select core.make_invite() $$, '42501', null, 'a plain account cannot make invites');
select is((select count(*) from core.invites), 0::bigint, 'nor see any');

-- An admin makes plain invites, sees and cancels only their own.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select ok(core.is_admin(), 'an admin of any app is an admin');
do $$ begin perform set_config('t.byadmin', core.make_invite(note => 'for Ned', days => 3), true); end $$;
do $$ begin perform set_config('t.cancel', core.make_invite(note => 'for nobody'), true); end $$;
select throws_ok($$ select core.make_invite('admin') $$, '42501', null, 'an admin cannot make invites that give a role');
select is((select count(*) from core.invites), 2::bigint, 'an admin sees only their own invites');
select is((select code from core.invites where note = 'for Ned'), current_setting('t.byadmin'), 'with their codes');
select throws_ok($$ select core.cancel_invite((select id from core.invites where note = 'for Uma' limit 1)) $$, '42501', null,
  'an admin cannot cancel someone else''s invite (they can''t even see it)');
reset role;
select throws_ok($$ select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}', true),
  core.cancel_invite((select id from core.invites where note = 'for Uma')) $$, '42501', null, 'not even by its id');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select lives_ok($$ select core.cancel_invite((select id from core.invites where note = 'for nobody')) $$, 'an admin cancels their own invite');
select is((select code from core.invites where note = 'for nobody'), null, 'a cancelled invite''s code is cleared');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000f", "role": "authenticated"}';
select throws_ok($$ select core.make_account('meg', 'MMMMMMMMMMMMMMMM', current_setting('t.cancel')) $$, 'RCINV', null, 'and it no longer works');

-- The admin's invite works, once.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000e", "role": "authenticated"}';
select lives_ok($$ select core.make_account('ned', 'NNNNNNNNNNNNNNNN', lower(current_setting('t.byadmin'))) $$, 'N joins with the admin''s invite');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000f", "role": "authenticated"}';
select throws_ok($$ select core.make_account('meg', 'MMMMMMMMMMMMMMMM', current_setting('t.byadmin')) $$, 'RCINV', null, 'a code works for one person only');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select ok((select code is null and used_by = '00000000-0000-0000-0000-00000000000e' from core.invites where note = 'for Ned'),
  'the admin sees it used, by whom, and its code is gone');

-- The superuser sees every invite; a deactivated admin can't make any.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
select is((select count(*) from core.invites), 6::bigint, 'the superuser sees every invite');
select lives_ok($$ select core.set_active('00000000-0000-0000-0000-00000000000a', false) $$, 'the superuser deactivates A');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select throws_ok($$ select core.make_invite() $$, '42501', null, 'a deactivated admin cannot make invites');
select is((select count(*) from core.invites), 0::bigint, 'nor see them');

select * from finish();
rollback;
