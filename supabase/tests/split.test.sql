-- Split (supabase/migrations/…_split.sql): groups, members and joining, categories, bills, payments, the log.
-- Run: supabase test db (CI's `supabase` job).
begin;
create extension if not exists pgtap with schema extensions;
select plan(51);

-- P: an account, the owner. A, B: anonymous phones (Ann, Ben). X: an outsider.
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
do $$ begin perform core.make_account('pat', 'PPPPPPPPPPPPPPPP', current_setting('t.p')); end $$;

reset role;
select ok((select bool_and(relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'split' and c.relkind = 'r'), 'row level security is on for every split table');
select is((select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'split'), 1::bigint,
  'the changes table is published to Realtime');
set local role authenticated;

-- ---------- groups ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
select throws_ok($$ select split.make_group('Dinner', 'Ann') $$, 'RCSPL', null, 'an anonymous sign-in can''t make a group');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
do $$ begin
  perform set_config('t.g', split.make_group('Friday dinner', 'Pat', '🍕')::text, true);
  perform set_config('t.pat', split.me(current_setting('t.g')::uuid)::text, true);
end $$;
select ok(split.is_owner(current_setting('t.g')::uuid), 'P makes a group and owns it');
select is((select count(*) from split.categories), 7::bigint, 'with the default categories');
select lives_ok($$ select split.edit_group(current_setting('t.g')::uuid, 'Friday dinner', '🍕', 'PHP', 'JPY', 0.37) $$, 'and adds a second currency');
do $$ begin
  perform set_config('t.ann', split.add_member(current_setting('t.g')::uuid, 'Ann', '🦊')::text, true);
  perform set_config('t.ben', split.add_member(current_setting('t.g')::uuid, 'Ben')::text, true);
  perform set_config('t.code', split.join_link(current_setting('t.g')::uuid), true);
end $$;
select throws_ok($$ select split.add_member(current_setting('t.g')::uuid, 'ann') $$, 'RCSPL', null, 'names are unique in a group');

-- ---------- joining ----------
set local role anon;
select is(jsonb_array_length(split.join_info(current_setting('t.code')) -> 'members'), 3, 'the link shows the names, signed out too');
select throws_ok($$ select * from split.groups $$, '42501', null, 'signed out, the tables aren''t readable');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
select is(split.claim(current_setting('t.code'), current_setting('t.ann')::uuid)::text, current_setting('t.g'), 'Ann''s phone picks Ann');
select throws_ok($$ select split.add_member(current_setting('t.g')::uuid, 'Cy') $$, 'RCSPL', null, 'only owners add people');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000b1", "role": "authenticated"}';
select throws_ok($$ select split.claim(current_setting('t.code'), current_setting('t.ann')::uuid) $$, 'RCSPL', null, 'a taken name can''t be picked');
do $$ begin perform split.claim(current_setting('t.code'), current_setting('t.ben')::uuid); end $$;
select is(split.me(current_setting('t.g')::uuid)::text, current_setting('t.ben'), 'Ben''s phone picks Ben');

-- ---------- bills ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
do $$ begin perform set_config('t.b1', split.save_bill(current_setting('t.g')::uuid, null, jsonb_build_object(
  'title', 'Pizza', 'kind', 'total', 'currency', 'PHP', 'spent_on', '2026-11-13',
  'lines', jsonb_build_array(jsonb_build_object('amount', 1500, 'members', jsonb_build_array(current_setting('t.pat'), current_setting('t.ann'), current_setting('t.ben')))),
  'payers', jsonb_build_object(current_setting('t.ann'), 1500)))::text, true); end $$;
select is((select title from split.bills where id = current_setting('t.b1')::uuid), 'Pizza', 'Ann (no account) adds a bill she paid, split three ways');
select is((select amount from split.bill_lines where bill_id = current_setting('t.b1')::uuid), 1500.00, 'its amount');
select throws_ok($$ select split.save_bill(current_setting('t.g')::uuid, null, jsonb_build_object('title', 'x', 'kind', 'total', 'currency', 'PHP',
  'lines', jsonb_build_array(jsonb_build_object('amount', 100, 'members', jsonb_build_array(current_setting('t.ann')))),
  'payers', jsonb_build_object(current_setting('t.ann'), 90))) $$, 'RCSPL', null, 'what was paid has to add up');
select throws_ok($$ select split.save_bill(current_setting('t.g')::uuid, null, jsonb_build_object('title', 'x', 'kind', 'total', 'currency', 'USD',
  'lines', jsonb_build_array(jsonb_build_object('amount', 100, 'members', jsonb_build_array(current_setting('t.ann')))),
  'payers', jsonb_build_object(current_setting('t.ann'), 100))) $$, 'RCSPL', null, 'only the group''s currencies');
select throws_ok($$ select split.save_bill(current_setting('t.g')::uuid, null, jsonb_build_object('title', 'x', 'kind', 'total', 'currency', 'PHP',
  'lines', jsonb_build_array(jsonb_build_object('amount', 50, 'members', jsonb_build_array(current_setting('t.ann'))),
    jsonb_build_object('amount', 50, 'members', jsonb_build_array(current_setting('t.ben')))),
  'payers', jsonb_build_object(current_setting('t.ann'), 100))) $$, 'RCSPL', null, 'a total is one amount');
select throws_ok($$ select split.save_bill(current_setting('t.g')::uuid, null, jsonb_build_object('title', 'x', 'kind', 'total', 'currency', 'PHP',
  'lines', jsonb_build_array(jsonb_build_object('amount', 100, 'members', jsonb_build_array('00000000-0000-0000-0000-0000000000ff'))),
  'payers', jsonb_build_object(current_setting('t.ann'), 100))) $$, 'RCSPL', null, 'shared only by people in the group');
select throws_ok($$ select split.save_bill(current_setting('t.g')::uuid, null, jsonb_build_object('title', 'x', 'kind', 'total', 'currency', 'PHP',
  'lines', jsonb_build_array(jsonb_build_object('amount', 100, 'members', jsonb_build_array(current_setting('t.ann')))),
  'payers', jsonb_build_object(current_setting('t.ann'), 100), 'made_by', current_setting('t.pat'))) $$, 'RCSPL', null, 'only bill fields can be given');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000b1", "role": "authenticated"}';
do $$ begin perform set_config('t.b2', split.save_bill(current_setting('t.g')::uuid, null, jsonb_build_object(
  'title', 'Drinks', 'kind', 'itemized', 'currency', 'JPY', 'category', (select id from split.categories where name = 'Drinks'),
  'lines', jsonb_build_array(
    jsonb_build_object('label', 'Beer', 'amount', 1200, 'members', jsonb_build_array(current_setting('t.pat'))),
    jsonb_build_object('label', 'Juice', 'amount', 600, 'members', jsonb_build_array(current_setting('t.ann'))),
    jsonb_build_object('label', 'Service', 'amount', 300, 'members', jsonb_build_array(current_setting('t.pat'), current_setting('t.ann'), current_setting('t.ben')))),
  'payers', jsonb_build_object(current_setting('t.ben'), 1500, current_setting('t.pat'), 600)))::text, true); end $$;
select is((select count(*) from split.bill_lines where bill_id = current_setting('t.b2')::uuid), 3::bigint, 'Ben adds an itemized receipt in yen, two payers');
select is((select sum(amount) from split.bill_payers where bill_id = current_setting('t.b2')::uuid), 2100.00, 'the payers add up');
select lives_ok($$ select split.save_bill(current_setting('t.g')::uuid, current_setting('t.b1')::uuid, jsonb_build_object(
  'title', 'Pizza and pasta', 'kind', 'total', 'currency', 'PHP',
  'lines', jsonb_build_array(jsonb_build_object('amount', 1800, 'members', jsonb_build_array(current_setting('t.pat'), current_setting('t.ann'), current_setting('t.ben')))),
  'payers', jsonb_build_object(current_setting('t.ann'), 1800))) $$, 'Ben corrects Ann''s bill (anyone can)');
select is((select count(*) from split.bill_lines where bill_id = current_setting('t.b1')::uuid), 1::bigint, 'its lines are replaced, not added');
reset role;
select is((select detail -> 'old' ->> 'title' || ' → ' || (detail -> 'new' ->> 'title') from split.log where action = 'bill.edit'),
  'Pizza → Pizza and pasta', 'the log keeps the old and new bill');
set local role authenticated;

-- ---------- what each reads ----------
select is((select count(*) from split.bills), 2::bigint, 'Ben reads the bills');
select is((select count(*) from split.log), 0::bigint, 'but not the log (owners only)');
select throws_ok($$ select join_code from split.groups $$, '42501', null, 'or the join code');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000ff", "role": "authenticated"}';
select is((select count(*) from split.bills) + (select count(*) from split.members) + (select count(*) from split.transfers), 0::bigint,
  'X, not in the group, reads nothing');
select throws_ok($$ select split.save_bill(current_setting('t.g')::uuid, null, '{}') $$, 'RCSPL', null, 'and can''t add bills');
select throws_ok($$ insert into split.transfers (group_id, from_member, to_member, amount, status, made_by)
  values (current_setting('t.g')::uuid, current_setting('t.ben')::uuid, current_setting('t.ann')::uuid, 1, 'confirmed', current_setting('t.ann')::uuid) $$,
  '42501', null, 'nobody writes the tables directly');

-- ---------- paying ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000b1", "role": "authenticated"}';
do $$ begin perform set_config('t.t1', split.record_transfer(current_setting('t.g')::uuid, current_setting('t.ben')::uuid,
  current_setting('t.ann')::uuid, 600, current_setting('t.b1')::uuid)::text, true); end $$;
select is((select status from split.transfers where id = current_setting('t.t1')::bigint), 'pending', 'Ben says he paid Ann his share: pending');
select throws_ok($$ select split.decide_transfer(current_setting('t.t1')::bigint, true) $$, 'RCSPL', null, 'Ben can''t confirm his own payment');
select throws_ok($$ select split.record_transfer(current_setting('t.g')::uuid, current_setting('t.pat')::uuid, current_setting('t.ann')::uuid, 100) $$,
  'RCSPL', null, 'or record one between others');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
select lives_ok($$ select split.decide_transfer(current_setting('t.t1')::bigint, true) $$, 'Ann confirms she received it');
select is((select status from split.transfers where id = current_setting('t.t1')::bigint), 'confirmed', 'it''s confirmed');
select throws_ok($$ select split.decide_transfer(current_setting('t.t1')::bigint, false) $$, 'RCSPL', null, 'and stays answered');
do $$ begin perform set_config('t.t2', split.record_transfer(current_setting('t.g')::uuid, current_setting('t.pat')::uuid,
  current_setting('t.ann')::uuid, 500, null, 'cash')::text, true); end $$;
select is((select status from split.transfers where id = current_setting('t.t2')::bigint), 'confirmed', 'Ann records cash from Pat: confirmed at once');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select throws_ok($$ select split.cancel_transfer(current_setting('t.t2')::bigint) $$, 'RCSPL', null, 'Pat can''t take back a confirmed payment');
do $$ begin perform set_config('t.t3', split.record_transfer(current_setting('t.g')::uuid, current_setting('t.pat')::uuid,
  current_setting('t.ben')::uuid, 400)::text, true); end $$;
select lives_ok($$ select split.cancel_transfer(current_setting('t.t3')::bigint) $$, 'but can take back a pending one');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
select lives_ok($$ select split.cancel_transfer(current_setting('t.t2')::bigint) $$, 'the one paid can undo a confirmed one');

-- ---------- categories, deleting, archiving ----------
select throws_ok($$ select split.add_category(current_setting('t.g')::uuid, 'Gifts') $$, 'RCSPL', null, 'only owners change categories');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select lives_ok($$ select split.delete_category((select id from split.categories where name = 'Drinks')) $$, 'P deletes Drinks');
select is((select category_id from split.bills where id = current_setting('t.b2')::uuid), null, 'its bill keeps no category');
select throws_ok($$ select split.edit_group(current_setting('t.g')::uuid, 'Friday dinner', '🍕', 'USD', 'JPY', 0.37) $$, 'RCSPL', null,
  'the currency can''t change once there are bills');
select lives_ok($$ select split.archive_group(current_setting('t.g')::uuid, true) $$, 'P archives the group');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000b1", "role": "authenticated"}';
select throws_ok($$ select split.delete_bill(current_setting('t.b1')::uuid) $$, 'RCSPL', null, 'archived, nothing changes');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
do $$ begin perform split.archive_group(current_setting('t.g')::uuid, false); end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000b1", "role": "authenticated"}';
select lives_ok($$ select split.delete_bill(current_setting('t.b1')::uuid) $$, 'brought back, Ben deletes a bill');
select is((select transfers.bill_id from split.transfers where id = current_setting('t.t1')::bigint), null, 'its payment stays, as a general one');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select ok((select detail -> 'old' ->> 'title' from split.log where action = 'bill.delete') = 'Pizza and pasta', 'the log keeps the deleted bill');
select ok((select version from split.changes) = (select version from split.groups), 'the changes row follows the group''s version');

select * from finish();
rollback;
