-- core accounts: making one with an invite, keys, roles, deactivating, superusers' tools and who sees what.
-- Run: supabase test db (CI's `supabase` job).
begin;
create extension if not exists pgtap with schema extensions;
select plan(89);

-- Four anonymous sign-ins: A (becomes the superuser), B, C and D. B has two devices signed in.
insert into auth.users (id, aud, role, is_anonymous) values
  ('00000000-0000-0000-0000-00000000000a', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000b', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000c', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000d', 'authenticated', 'authenticated', true);
insert into core.profiles (id, display_name, avatar) values ('00000000-0000-0000-0000-00000000000b', 'Ben', '🐸');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000000b');
insert into auth.refresh_tokens (token, user_id, session_id) values
  ('t1', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1'),
  ('t2', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b2');

select ok((select bool_and(relrowsecurity) from pg_class where oid in
  ('core.accounts'::regclass, 'core.roles'::regclass, 'core.invites'::regclass, 'core.audit'::regclass)),
  'row level security is on for every new table');

-- Codes: 16 characters, read back however people type them.
select matches(core.new_code(), '^[0-9A-HJKMNP-TV-Z]{16}$', 'a new code is 16 Crockford base32 characters');
select is(core.clean_code(' 7kqm-2xrp h9td-4wvn '), '7KQM2XRPH9TD4WVN', 'codes are read in any case, with dashes and spaces');
select is(core.clean_code('OIL0'), '0110', 'O reads as 0, I and L as 1');

-- Not signed in: nothing.
set local role anon;
select throws_ok($$ select * from core.accounts $$, '42501', null, 'anon cannot read accounts');
select throws_ok($$ select core.make_invite() $$, '42501', null, 'anon cannot make invites');
reset role;

-- The first superuser's invite: only by hand (the database's own role).
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select throws_ok($$ select core.first_invite() $$, '42501', null, 'pages cannot call first_invite');
select throws_ok($$ select core.end_sessions('00000000-0000-0000-0000-00000000000b') $$, '42501', null, 'nor the database''s own helpers');
select throws_ok($$ select core.set_key('00000000-0000-0000-0000-00000000000b', 'AAAABBBBCCCCDDDD') $$, '42501', null, 'such as setting a key');
reset role;
do $$ begin perform set_config('t.first', core.first_invite(), true); end $$;
select matches(current_setting('t.first'), '^[0-9A-HJKMNP-TV-Z]{16}$', 'first_invite returns a code');
select is((select count(*) from core.invites where code_hash = core.hash_code(current_setting('t.first'))), 1::bigint,
  'only the code''s hash is stored');

-- A makes the first account.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select throws_ok($$ select core.make_account('jun', 'AAAABBBBCCCCDDDD', 'WRONGWRONGWRONG0') $$, 'RCINV', null, 'a wrong invite code is refused');
select throws_ok($$ select core.make_account('J', 'AAAABBBBCCCCDDDD', current_setting('t.first')) $$, 'RCUSR', null, 'a bad username is refused');
select throws_ok($$ select core.make_account('jun<b>', 'AAAABBBBCCCCDDDD', current_setting('t.first')) $$, 'RCUSR', null, 'usernames are letters, numbers and _');
select throws_ok($$ select core.make_account('jun', 'short', current_setting('t.first')) $$, 'RCKEY', null, 'a weak key is refused');
select throws_ok($$ select core.make_account('jun', 'AAAABBBBCCCCDDDI', current_setting('t.first')) $$, 'RCKEY', null, 'keys are cleaned by the page first');
select lives_ok($$ select core.make_account('jun', 'AAAABBBBCCCCDDDD', lower(current_setting('t.first'))) $$, 'A makes an account with the invite');
select throws_ok($$ select core.make_account('jun2', 'AAAABBBBCCCCDDDD', current_setting('t.first')) $$, '42501', null, 'an account cannot make another');
select ok(core.is_superuser(), 'the first invite makes A a superuser');
select ok(core.has_role('admin', 'pickleball'), 'a superuser has every role in every app');
reset role;

select is((select email from auth.users where id = '00000000-0000-0000-0000-00000000000a'), 'jun@users.reclaude.invalid', 'the sign-in address is made up from the username');
select ok((select not is_anonymous and email_confirmed_at is not null from auth.users where id = '00000000-0000-0000-0000-00000000000a'),
  'the sign-in is no longer anonymous, and its address needs no confirming');
select ok((select encrypted_password = extensions.crypt('AAAABBBBCCCCDDDD', encrypted_password) from auth.users where id = '00000000-0000-0000-0000-00000000000a'),
  'the key is the password, stored as a bcrypt hash');
select matches((select encrypted_password from auth.users where id = '00000000-0000-0000-0000-00000000000a'), '^\$2a\$10\$', 'bcrypt, cost 10');
select is((select count(*) from auth.identities where user_id = '00000000-0000-0000-0000-00000000000a' and provider = 'email'), 1::bigint, 'it has an email identity');
select ok((select used_by = '00000000-0000-0000-0000-00000000000a' from core.invites where code_hash = core.hash_code(current_setting('t.first'))), 'the invite is used up');
select throws_ok($$ select core.first_invite() $$, '42501', null, 'no more first invites once there is a superuser');

-- A invites B; the code can only be used once.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select throws_ok($$ select core.make_invite(days => 0) $$, '22023', null, 'an invite lasts at least a day');
select throws_ok($$ select core.make_invite(days => 31) $$, '22023', null, 'and at most 30 days');
select throws_ok($$ select core.make_invite('admin', 'pickleball') $$, '23514', null, 'core roles are for every project');
do $$ begin perform set_config('t.plain', core.make_invite(), true); end $$;
do $$ begin perform set_config('t.admin', core.make_invite('admin', '*', 3), true); end $$;
do $$ begin perform set_config('t.cancel', core.make_invite(), true); end $$;
select lives_ok($$ select core.cancel_invite((select max(id) from core.invites)) $$, 'A cancels an invite');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
select throws_ok($$ select core.make_account('ben', 'BBBBBBBBBBBBBBBB', current_setting('t.first')) $$, 'RCINV', null, 'a used invite is refused');
select throws_ok($$ select core.make_account('ben', 'BBBBBBBBBBBBBBBB', current_setting('t.cancel')) $$, 'RCINV', null, 'a cancelled invite is refused');
select throws_ok($$ select core.make_account('jun', 'BBBBBBBBBBBBBBBB', current_setting('t.plain')) $$, 'RCTKN', null, 'a taken username is refused');
select lives_ok($$ select core.make_account('ben', 'BBBBBBBBBBBBBBBB', current_setting('t.plain')) $$, 'B makes an account');
select is((select display_name from core.profiles where id = '00000000-0000-0000-0000-00000000000b'), 'Ben', 'B keeps their profile');
select ok(not core.is_superuser() and not core.has_role('admin', 'pickleball'), 'a plain invite gives no role');

-- B is no superuser: sees only their own account, and can't use the superusers' tools.
select is((select count(*) from core.accounts), 1::bigint, 'B sees only their own account');
select is((select count(*) from core.roles), 0::bigint, 'B sees no roles (they have none)');
select is((select count(*) from core.invites), 0::bigint, 'B sees no invites');
select is((select count(*) from core.audit), 0::bigint, 'B sees no audit log');
select throws_ok($$ select core.make_invite() $$, '42501', null, 'B cannot make invites');
select throws_ok($$ select core.set_active('00000000-0000-0000-0000-00000000000a', false) $$, '42501', null, 'B cannot deactivate anyone');
select throws_ok($$ select core.reset_key('00000000-0000-0000-0000-00000000000a') $$, '42501', null, 'B cannot reset keys');
select throws_ok($$ select core.edit_account('00000000-0000-0000-0000-00000000000a', 'hacked') $$, '42501', null, 'B cannot edit accounts');
select throws_ok($$ select core.cancel_invite(1) $$, '42501', null, 'B cannot cancel invites');
select throws_ok($$ insert into core.roles (user_id, role) values ('00000000-0000-0000-0000-00000000000b', 'superuser') $$, '42501', null, 'B cannot give themselves a role');
select throws_ok($$ update core.accounts set active = true $$, '42501', null, 'B cannot change accounts directly');

-- C: a core admin.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select lives_ok($$ select core.make_account('cyd', 'CCCCCCCCCCCCCCCC', current_setting('t.admin')) $$, 'C makes an account with an admin invite');
select ok(core.has_role('admin') and core.has_role('admin', 'pickleball'), 'C is an admin, for every project');
select ok(not core.has_role('superuser') and not core.is_superuser(), 'but no superuser');
select throws_ok($$ select core.make_invite('admin') $$, '42501', null, 'an admin cannot make invites that give a role');

-- A, the superuser, sees everything.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select is((select count(*) from core.accounts), 3::bigint, 'a superuser sees every account');
select is((select count(*) from core.invites), 4::bigint, 'and every invite');
select is((select count(*) from core.audit where action = 'made account'), 3::bigint, 'and the audit log');

-- Deactivating B: signed out everywhere, can't sign in, read or change anything; their data stays.
select throws_ok($$ select core.set_active('00000000-0000-0000-0000-00000000000a', false) $$, '42501', null, 'A cannot deactivate themselves');
select lives_ok($$ select core.set_active('00000000-0000-0000-0000-00000000000b', false) $$, 'A deactivates B');
reset role;
select ok((select banned_until > now() + interval '100 years' from auth.users where id = '00000000-0000-0000-0000-00000000000b'), 'B can''t sign in');
select is((select count(*) from auth.sessions where user_id = '00000000-0000-0000-0000-00000000000b'), 0::bigint, 'B is signed out everywhere');
select is((select count(*) from auth.refresh_tokens where user_id = '00000000-0000-0000-0000-00000000000b'), 0::bigint, 'B''s devices can''t renew their sign-in');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
select ok(not core.is_active(), 'B is not active');
select is((select count(*) from core.profiles), 0::bigint, 'a deactivated account reads no profiles');
update core.profiles set display_name = 'Gone' where id = '00000000-0000-0000-0000-00000000000b';
select throws_ok($$ select core.change_key('DDDDDDDDDDDDDDDD') $$, '42501', null, 'a deactivated account cannot change its key');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select is((select display_name from core.profiles where id = '00000000-0000-0000-0000-00000000000b'), 'Ben', 'B''s data stays (and B couldn''t edit it)');
select lives_ok($$ select core.set_active('00000000-0000-0000-0000-00000000000b', true) $$, 'A reactivates B');
reset role;
select ok((select banned_until is null from auth.users where id = '00000000-0000-0000-0000-00000000000b'), 'B can sign in again');

-- Keys: a superuser resets B's (signing B out); B changes their own (signing out their other devices).
insert into auth.sessions (id, user_id) values
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-00000000000b'),
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-00000000000b');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select throws_ok($$ select core.reset_key('00000000-0000-0000-0000-00000000000a') $$, '42501', null, 'a superuser changes their own key from their profile');
do $$ begin perform set_config('t.reset', core.reset_key('00000000-0000-0000-0000-00000000000b'), true); end $$;
reset role;
select ok((select encrypted_password = extensions.crypt(current_setting('t.reset'), encrypted_password) from auth.users where id = '00000000-0000-0000-0000-00000000000b'),
  'reset_key gives B a new key');
select is((select count(*) from auth.sessions where user_id = '00000000-0000-0000-0000-00000000000b'), 0::bigint, 'and signs B out');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-0000-0000-0000000000b5', '00000000-0000-0000-0000-00000000000b'),
  ('00000000-0000-0000-0000-0000000000b6', '00000000-0000-0000-0000-00000000000b');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated", "session_id": "00000000-0000-0000-0000-0000000000b5"}';
select throws_ok($$ select core.change_key('1234') $$, 'RCKEY', null, 'a new key must be a strong one');
select lives_ok($$ select core.change_key('EEEEEEEEEEEEEEEE') $$, 'B changes their key');
reset role;
select ok((select encrypted_password = extensions.crypt('EEEEEEEEEEEEEEEE', encrypted_password) from auth.users where id = '00000000-0000-0000-0000-00000000000b'), 'B''s key is the new one');
select results_eq($$ select id from auth.sessions where user_id = '00000000-0000-0000-0000-00000000000b' $$,
  $$ values ('00000000-0000-0000-0000-0000000000b5'::uuid) $$, 'B stays signed in on this device only');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000d", "role": "authenticated"}';
select throws_ok($$ select core.change_key('EEEEEEEEEEEEEEEE') $$, '42501', null, 'an anonymous user has no key to change');

-- Editing B: username (and so their sign-in address) and profile.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select throws_ok($$ select core.edit_account('00000000-0000-0000-0000-00000000000b', 'cyd') $$, 'RCTKN', null, 'a taken username is refused');
select throws_ok($$ select core.edit_account('00000000-0000-0000-0000-00000000000b', 'Benny!') $$, 'RCUSR', null, 'a bad username is refused');
select throws_ok($$ select core.edit_account('00000000-0000-0000-0000-00000000000b', null, '<b>') $$, '23514', null, 'a bad name is refused');
select lives_ok($$ select core.edit_account('00000000-0000-0000-0000-00000000000b', 'benny', 'Benny', '🐼') $$, 'A edits B');
reset role;
select is((select username from core.accounts where id = '00000000-0000-0000-0000-00000000000b'), 'benny', 'B''s username changes');
select ok((select u.email = 'benny@users.reclaude.invalid' and i.email = 'benny@users.reclaude.invalid'
  from auth.users u join auth.identities i on i.user_id = u.id where u.id = '00000000-0000-0000-0000-00000000000b'), 'and so does their sign-in address');
select is((select display_name || avatar from core.profiles where id = '00000000-0000-0000-0000-00000000000b'), 'Benny🐼', 'and their profile');
select is((select array_agg(action order by id) from core.audit where target = '00000000-0000-0000-0000-00000000000b'),
  array['made account', 'deactivated', 'reactivated', 'reset key', 'changed key', 'edited account'], 'every change is in the audit log');

-- Account addresses stay the database's: nothing else (Supabase's sign-in service, the dashboard) can hand one out
-- or change one.
select throws_ok($$ insert into auth.users (id, aud, role, email) values (gen_random_uuid(), 'authenticated', 'authenticated', 'jun2@users.reclaude.invalid') $$,
  '42501', null, 'signing up with an account address is refused');
select throws_ok($$ update auth.users set email = 'ben@example.com' where id = '00000000-0000-0000-0000-00000000000b' $$, '42501', null, 'an account cannot move to a real address');
select throws_ok($$ update auth.users set email_change = 'ben@example.com' where id = '00000000-0000-0000-0000-00000000000b' $$, '42501', null, 'nor ask to');
select throws_ok($$ update auth.users set email = 'cyd@users.reclaude.invalid' where id = '00000000-0000-0000-0000-00000000000d' $$, '42501', null, 'nor can an anonymous user take an account address');
select lives_ok($$ update auth.users set email = email, email_change = '', updated_at = now() where id = '00000000-0000-0000-0000-00000000000b' $$, 'other sign-in updates are fine');
select lives_ok($$ insert into auth.users (id, aud, role, email) values (gen_random_uuid(), 'authenticated', 'authenticated', 'someone@example.com') $$, 'and other addresses are fine');

-- Accounts are never deleted.
select throws_ok($$ delete from auth.users where id = '00000000-0000-0000-0000-00000000000b' $$, '23503', null, 'an account''s sign-in cannot be deleted');

select * from finish();
rollback;
