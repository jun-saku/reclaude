-- Trip sections (supabase/migrations/…_trip_sections.sql): sections, locking, notes, itinerary items, opt-outs.
-- Run: supabase test db (CI's `supabase` job).
begin;
create extension if not exists pgtap with schema extensions;
select plan(40);

-- P: an account, the planner. A: an anonymous phone that joins as Ann. X: an outsider.
insert into auth.users (id, aud, role, is_anonymous) values
  ('00000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-00000000000c', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', true),
  ('00000000-0000-0000-0000-0000000000ff', 'authenticated', 'authenticated', true);
do $$ begin perform set_config('t.first', core.first_invite(), true); end $$;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000005", "role": "authenticated"}';
do $$ begin
  perform core.make_account('sam', 'SSSSSSSSSSSSSSSS', current_setting('t.first'));
  perform set_config('t.p', core.make_invite(), true);
end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
do $$ begin
  perform core.make_account('pat', 'PPPPPPPPPPPPPPPP', current_setting('t.p'));
  perform set_config('t.trip', trip.make_trip('Tokyo', 'Pat', '🗼', '2026-12-01', '2026-12-04')::text, true);
  perform trip.edit_trip(current_setting('t.trip')::uuid, 'Tokyo', '🗼', '2026-12-01', '2026-12-04', 'PHP', 'JPY', 0.37);
  perform set_config('t.ann', trip.add_person(current_setting('t.trip')::uuid, 'Ann')::text, true);
  perform set_config('t.code', trip.join_link(current_setting('t.trip')::uuid), true);
end $$;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
do $$ begin perform trip.claim(current_setting('t.code'), current_setting('t.ann')::uuid); end $$;

reset role;
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('trip.sections'::regclass, 'trip.items'::regclass,
  'trip.optouts'::regclass)), 'row level security is on for sections, items and opt-outs');
set local role authenticated;

-- ---------- sections ----------
select throws_ok($$ select trip.add_section(current_setting('t.trip')::uuid, 'poll', 'Where?') $$, '23514', null, 'only known kinds');
do $$ begin
  perform set_config('t.notes', trip.add_section(current_setting('t.trip')::uuid, 'notes', 'Ideas')::text, true);
  perform set_config('t.plan', trip.add_section(current_setting('t.trip')::uuid, 'itinerary', 'Plan')::text, true);
end $$;
select is((select array_agg(title order by position) from trip.sections), array['Ideas', 'Plan'], 'Ann (no account) adds two sections, in order');
select lives_ok($$ select trip.order_sections(current_setting('t.trip')::uuid, array[current_setting('t.plan'), current_setting('t.notes')]::uuid[]) $$,
  'and puts the itinerary first');
select is((select array_agg(title order by position) from trip.sections), array['Plan', 'Ideas'], 'the new order');
select throws_ok($$ select trip.order_sections(current_setting('t.trip')::uuid, array[current_setting('t.plan')]::uuid[]) $$, 'RCTRP', null,
  'an order has to name every section');
select lives_ok($$ select trip.edit_section(current_setting('t.plan')::uuid, 'Day by day', true) $$, 'renames it and groups it by day');
select throws_ok($$ select trip.lock_section(current_setting('t.plan')::uuid, true) $$, 'RCTRP', null, 'only planners lock');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000ff", "role": "authenticated"}';
select throws_ok($$ select trip.add_section(current_setting('t.trip')::uuid, 'notes', 'Mine') $$, 'RCTRP', null, 'X, not on the trip, can''t add');
select is((select count(*) from trip.sections), 0::bigint, 'or read any');

-- ---------- notes ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
select is(trip.save_note(current_setting('t.notes')::uuid, 0, '# Food' || chr(10) || '- ramen'), 1, 'Ann saves the notes: version 1');
select throws_ok($$ select trip.save_note(current_setting('t.notes')::uuid, 0, 'old copy') $$, 'RCTRP', null,
  'a save from an older version is refused');
select is((select body from trip.sections where id = current_setting('t.notes')::uuid), '# Food' || chr(10) || '- ramen', 'the newer text stays');
select throws_ok($$ select trip.save_note(current_setting('t.plan')::uuid, 0, 'x') $$, 'RCTRP', null, 'an itinerary has no text');

-- ---------- items ----------
do $$ begin
  perform set_config('t.i1', trip.add_item(current_setting('t.plan')::uuid, '{"title": "Flight to NRT", "day": "2026-12-01", "starts_at": "08:00",
    "place": "NAIA Terminal 3"}')::text, true);
  perform set_config('t.i2', trip.add_item(current_setting('t.plan')::uuid, '{"title": "Ramen", "day": "2026-12-01"}')::text, true);
  perform set_config('t.i3', trip.add_item(current_setting('t.plan')::uuid, '{"title": "Ghibli museum"}')::text, true);
end $$;
select is((select count(*) from trip.items), 3::bigint, 'Ann adds three items (one unscheduled)');
select throws_ok($$ select trip.add_item(current_setting('t.notes')::uuid, '{"title": "x"}') $$, 'RCTRP', null, 'notes take no items');
select throws_ok($$ select trip.add_item(current_setting('t.plan')::uuid, '{"title": "x", "made_by": null}') $$, 'RCTRP', null,
  'only item fields can be given');
select throws_ok($$ select trip.add_item(current_setting('t.plan')::uuid, '{"title": "x", "link": "javascript:alert(1)"}') $$, '23514', null,
  'links are http(s) only');
select throws_ok($$ select trip.add_item(current_setting('t.plan')::uuid, '{"title": "x", "cost": 100, "cost_currency": "USD"}') $$, 'RCTRP', null,
  'costs are in the trip''s currencies');
select throws_ok($$ select trip.add_item(current_setting('t.plan')::uuid, '{"title": "x", "ends_at": "10:00"}') $$, '23514', null,
  'an end time needs a start time');
select lives_ok($$ select trip.edit_item(current_setting('t.i3')::uuid, jsonb_build_object('day', '2026-12-02', 'cost', 1000, 'cost_currency', 'JPY',
  'going', jsonb_build_array(current_setting('t.ann')))) $$, 'Ann schedules the museum, with a cost and who''s going');
select is((select day::text || ' ' || cost::text || ' ' || cost_currency || ' ' || cardinality(going) from trip.items where id = current_setting('t.i3')::uuid),
  '2026-12-02 1000.00 JPY 1', 'the item has its details');
select lives_ok($$ select trip.edit_item(current_setting('t.i3')::uuid, '{"cost": null, "cost_currency": null, "going": null}') $$, 'and clears them again');
select is((select going from trip.items where id = current_setting('t.i3')::uuid), null, 'everyone''s going');
select is((select title from trip.items where id = current_setting('t.i3')::uuid), 'Ghibli museum', 'fields not given stay');
select throws_ok($$ select trip.edit_item(current_setting('t.i3')::uuid, '{"going": ["00000000-0000-0000-0000-0000000000ff"]}') $$, 'RCTRP', null,
  'only people on the trip can be going');

-- order within a day
select lives_ok($$ select trip.move_item(current_setting('t.i2')::uuid, -1) $$, 'Ann moves Ramen up');
select is((select array_agg(title order by position) from trip.items where day = '2026-12-01'), array['Ramen', 'Flight to NRT'], 'Ramen is first on its day');

-- opt-outs
select lives_ok($$ select trip.opt_out(current_setting('t.i2')::uuid, 'not_interested') $$, 'Ann isn''t interested in ramen');
select throws_ok($$ select trip.opt_out(current_setting('t.i2')::uuid, 'maybe') $$, '23514', null, 'only "not going" or "not interested"');
select is((select kind from trip.optouts where item_id = current_setting('t.i2')::uuid), 'not_interested', 'her opt-out shows');
select lives_ok($$ select trip.opt_out(current_setting('t.i2')::uuid, null) $$, 'and she takes it back');

-- ---------- locking ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select lives_ok($$ select trip.lock_section(current_setting('t.plan')::uuid, true) $$, 'P locks the itinerary');
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';
select throws_ok($$ select trip.edit_item(current_setting('t.i1')::uuid, '{"title": "Flight"}') $$, 'RCTRP', null, 'Ann can''t change a locked section''s items');
select throws_ok($$ select trip.delete_section(current_setting('t.plan')::uuid) $$, 'RCTRP', null, 'or delete it');
select lives_ok($$ select trip.opt_out(current_setting('t.i1')::uuid, 'not_going') $$, 'but she can still say she''s not going');

-- ---------- deleting, and the log ----------
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000000c", "role": "authenticated"}';
select lives_ok($$ select trip.delete_section(current_setting('t.plan')::uuid) $$, 'P deletes the itinerary');
select is((select count(*) from trip.items), 0::bigint, 'its items go with it');
select is((select jsonb_array_length(detail -> 'old' -> 'items') from trip.log where action = 'section.delete'), 3,
  'the log keeps the section and its items');
select ok((select version from trip.trips) > 10, 'every change moved the trip''s version on');

select * from finish();
rollback;
