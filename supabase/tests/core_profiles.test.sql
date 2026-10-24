-- core.profiles: who can read, create and edit profiles. Run: supabase test db (CI's `supabase` job).
begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

-- Two signed-in users, A and B.
insert into auth.users (id, aud, role) values
  ('00000000-0000-0000-0000-00000000000a', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000b', 'authenticated', 'authenticated');

select has_schema('core');
select ok((select relrowsecurity from pg_class where oid = 'core.profiles'::regclass), 'row level security is on');

-- Not signed in: no access at all.
set local role anon;
select throws_ok($$ select * from core.profiles $$, '42501', null, 'anon cannot read profiles');
reset role;

-- As A.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select lives_ok($$ insert into core.profiles (display_name, avatar) values ('Ana', '🦊') $$, 'A creates their own profile');
select is((select id from core.profiles where display_name = 'Ana'), '00000000-0000-0000-0000-00000000000a'::uuid, 'the id defaults to the signed-in user');
select throws_ok($$ insert into core.profiles (id, display_name) values ('00000000-0000-0000-0000-00000000000b', 'Fake B') $$,
  '42501', null, 'A cannot create a profile for B');
select throws_ok($$ insert into core.profiles (display_name) values ('Ana again') $$, '23505', null, 'A cannot have two profiles');
select throws_ok($$ update core.profiles set display_name = '<b>Ana</b>' $$, '23514', null, 'names with < > & are refused');
select throws_ok($$ update core.profiles set display_name = '' $$, '23514', null, 'empty names are refused');
select throws_ok($$ update core.profiles set display_name = ' Ana' $$, '23514', null, 'names with outer spaces are refused');
select throws_ok($$ update core.profiles set display_name = E'Ana‮gnp.exe' $$, '23514', null, 'names with a direction override are refused');
select throws_ok($$ update core.profiles set display_name = E'An​a' $$, '23514', null, 'names with a zero-width space are refused');
select throws_ok($$ update core.profiles set avatar = E'⁦🦊' $$, '23514', null, 'avatars with invisible characters are refused');
select lives_ok($$ update core.profiles set display_name = 'Ána ジュン', avatar = E'\U0001F468‍\U0001F469‍\U0001F467' $$,
  'accents, other scripts and joined emoji are fine');
select throws_ok($$ update core.profiles set created_at = now() - interval '1 year' $$, '42501', null, 'A cannot change created_at');
select throws_ok($$ select core.touch_updated_at() $$, '42501', null, 'A cannot call the trigger helper');
select throws_ok($$ delete from core.profiles $$, '42501', null, 'A cannot delete profiles (deleting the account does)');

-- As B: reads A, cannot change A.
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}';
select lives_ok($$ insert into core.profiles (display_name) values ('Ben') $$, 'B creates their own profile');
select is((select display_name from core.profiles where id = '00000000-0000-0000-0000-00000000000a'), 'Ána ジュン', 'B can read A''s profile');
update core.profiles set display_name = 'Hacked' where id = '00000000-0000-0000-0000-00000000000a';
select is((select display_name from core.profiles where id = '00000000-0000-0000-0000-00000000000a'), 'Ána ジュン', 'B cannot rename A');
select lives_ok($$ update core.profiles set display_name = 'Benjamin', avatar = null $$, 'B edits their own profile');

select * from finish();
rollback;
