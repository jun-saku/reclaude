-- Trip: the page's sections, starting with Notes and Itinerary (apps/_trip-plan.md).
--   sections: a trip's page is a list of sections people add, rename, reorder and delete. Everyone on the trip edits;
--     a planner can lock a section (then only planners change it or what's in it). Kinds: notes, itinerary (more
--     come with their own migrations).
--   notes: a section's text (simple formatting the page draws: headings, bold, lists, links). Saved with the version
--     it was read at: if someone else saved first, the save is refused and the page shows theirs.
--   items: an itinerary's entries: a title, an optional day (the list can be grouped by day), start and end times,
--     a place (opens in maps), a link and a note; optional details: who's going (some of the people; none: everyone)
--     and a cost estimate (in the trip's home or local currency).
--   opt-outs: anyone marks an item "not going" or "not interested" for themselves.
-- trips.version goes up on every logged change, so a page can tell cheaply when to fetch again.
-- As before, every change is a function that checks who may do it and writes the log (deletes keep what was deleted).

alter table trip.trips add column version bigint not null default 0;
grant select (version) on trip.trips to authenticated;

create or replace function trip.note(trip uuid, action text, target uuid default null, detail jsonb default null) returns void
language sql volatile set search_path = '' as $$
  insert into trip.log (trip_id, person_id, actor, action, target, detail)
  values (trip, trip.me(trip), (select auth.uid()), action, target, detail);
  update trip.trips t set version = t.version + 1 where t.id = trip;
$$;

-- ---------- tables ----------

create table trip.sections (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trip.trips (id) on delete cascade,
  kind text not null check (kind in ('notes', 'itinerary')),
  title text not null check (title = btrim(title) and char_length(title) between 1 and 60
    and title !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]'),
  position int not null,
  locked boolean not null default false,
  by_day boolean not null default false,        -- itinerary: grouped by day
  body text not null default '' check (char_length(body) <= 20000),   -- notes
  version int not null default 0,               -- +1 on every save of the body
  made_by uuid references trip.people (id),
  made_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on trip.sections (trip_id, position);

create table trip.items (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references trip.sections (id) on delete cascade,
  trip_id uuid not null references trip.trips (id) on delete cascade,
  title text not null check (title = btrim(title) and char_length(title) between 1 and 120
    and title !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]'),
  day date,
  starts_at time,
  ends_at time check (ends_at is null or starts_at is not null),
  place text check (char_length(place) between 1 and 200 and place !~ '[<>[:cntrl:]]'),
  link text check (char_length(link) <= 500 and link ~ '^https?://[^\s<>"]+$'),
  note text check (char_length(note) between 1 and 2000),
  going uuid[] check (cardinality(going) between 1 and 100),   -- null: everyone
  cost numeric(14, 2) check (cost >= 0),
  cost_currency text check (cost_currency ~ '^[A-Z]{3}$'),
  position int not null default 0,
  made_by uuid references trip.people (id),
  made_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((cost is null) = (cost_currency is null))
);
create index on trip.items (section_id);
create index on trip.items (trip_id);

create table trip.optouts (
  item_id uuid not null references trip.items (id) on delete cascade,
  person_id uuid not null references trip.people (id) on delete cascade,
  trip_id uuid not null references trip.trips (id) on delete cascade,
  kind text not null check (kind in ('not_going', 'not_interested')),
  at timestamptz not null default now(),
  primary key (item_id, person_id)
);
create index on trip.optouts (trip_id);

alter table trip.sections enable row level security;
alter table trip.items enable row level security;
alter table trip.optouts enable row level security;

-- ---------- who may do what ----------

-- Someone on the trip, the trip isn't archived; returns their person id.
create function trip.require_editor(trip uuid) returns uuid
language plpgsql stable set search_path = '' as $$
declare
  person uuid := trip.me(trip);
begin
  if person is null then perform trip.refuse('Only people on this trip can do that.'); end if;
  if exists (select 1 from trip.trips t where t.id = trip and t.archived_at is not null) then
    perform trip.refuse('This trip is archived. A planner can bring it back first.');
  end if;
  return person;
end;
$$;

-- May change this section and what's in it: someone on the trip, and a planner if it's locked. Returns the section.
create function trip.require_section(section uuid) returns trip.sections
language plpgsql stable set search_path = '' as $$
declare
  s trip.sections;
begin
  select * into s from trip.sections x where x.id = section;
  if not found then perform trip.refuse('That section isn''t there any more.'); end if;
  perform trip.require_editor(s.trip_id);
  if s.locked and not trip.is_planner(s.trip_id) then
    perform trip.refuse('A planner locked this section. Ask them to unlock it.');
  end if;
  return s;
end;
$$;

create function trip.section_json(s trip.sections) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('kind', s.kind, 'title', s.title, 'locked', s.locked, 'by_day', s.by_day);
$$;

create function trip.item_json(i trip.items) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object('title', i.title, 'day', i.day, 'starts_at', i.starts_at, 'ends_at', i.ends_at,
    'place', i.place, 'link', i.link, 'note', i.note, 'going', i.going, 'cost', i.cost, 'cost_currency', i.cost_currency));
$$;

-- ---------- sections ----------

-- Adds a section at the end of the page. Returns its id.
create function trip.add_section(trip uuid, kind text, title text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  person uuid := trip.require_editor(trip);
  new_id uuid;
begin
  insert into trip.sections (trip_id, kind, title, position, made_by)
  values (trip, kind, title, coalesce((select max(s.position) + 1 from trip.sections s where s.trip_id = trip), 0), person)
  returning sections.id into new_id;
  perform trip.note(trip, 'section.add', new_id, jsonb_build_object('new', (select trip.section_json(s) from trip.sections s where s.id = new_id)));
  return new_id;
end;
$$;

-- Renames it, and (itinerary) groups it by day or not.
create function trip.edit_section(section uuid, title text, by_day boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s trip.sections := trip.require_section(section);
  new jsonb;
begin
  update trip.sections x set title = edit_section.title, by_day = coalesce(edit_section.by_day, false), updated_at = now()
  where x.id = section returning trip.section_json(x) into new;
  if new is distinct from trip.section_json(s) then
    perform trip.note(s.trip_id, 'section.edit', section, jsonb_build_object('old', trip.section_json(s), 'new', new));
  end if;
end;
$$;

-- Puts the page's sections in this order (every one of them, once).
create function trip.order_sections(trip uuid, sections uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform trip.require_editor(trip);
  if (select array_agg(s.id order by s.id) from trip.sections s where s.trip_id = trip)
      is distinct from (select array_agg(x order by x) from unnest(sections) x) then
    perform trip.refuse('The page changed meanwhile. Showing the latest.');
  end if;
  update trip.sections s set position = o.n from unnest(sections) with ordinality as o(id, n)
  where s.id = o.id and s.position <> o.n;
  if found then perform trip.note(trip, 'section.order', null, jsonb_build_object('order', to_jsonb(sections))); end if;
end;
$$;

-- Planners lock a section (only planners change it then) or unlock it.
create function trip.lock_section(section uuid, locked boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t uuid := (select s.trip_id from trip.sections s where s.id = section);
begin
  if t is null then perform trip.refuse('That section isn''t there any more.'); end if;
  perform trip.require_planner(t);
  update trip.sections s set locked = lock_section.locked where s.id = section and s.locked <> lock_section.locked;
  if found then perform trip.note(t, case when locked then 'section.lock' else 'section.unlock' end, section); end if;
end;
$$;

-- Deletes a section and what's in it; the log keeps all of it.
create function trip.delete_section(section uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s trip.sections := trip.require_section(section);
begin
  perform trip.note(s.trip_id, 'section.delete', section, jsonb_build_object('old', trip.section_json(s) || jsonb_build_object(
    'body', nullif(s.body, ''),
    'items', (select jsonb_agg(trip.item_json(i) order by i.day nulls first, i.starts_at nulls first, i.position) from trip.items i where i.section_id = section))));
  delete from trip.sections x where x.id = section;
end;
$$;

-- ---------- notes ----------

-- Saves a notes section's text if nobody saved since `version`; returns the new version.
create function trip.save_note(section uuid, version int, body text) returns int
language plpgsql security definer set search_path = '' as $$
declare
  s trip.sections := trip.require_section(section);
  now_version int;
begin
  if s.kind <> 'notes' then perform trip.refuse('That isn''t a notes section.'); end if;
  if s.version <> save_note.version then perform trip.refuse('Someone else saved this meanwhile. Showing theirs; copy yours back in if you need to.'); end if;
  if s.body = coalesce(save_note.body, '') then return s.version; end if;
  update trip.sections x set body = coalesce(save_note.body, ''), version = x.version + 1, updated_at = now()
  where x.id = section returning x.version into now_version;
  perform trip.note(s.trip_id, 'note.save', section, jsonb_build_object('old', s.body, 'new', body));
  return now_version;
end;
$$;

-- ---------- itinerary items ----------

-- What an item's fields may be given as: { title, day, starts_at, ends_at, place, link, note, going, cost, cost_currency }.
create function trip.check_item_fields(trip uuid, fields jsonb) returns void
language plpgsql stable set search_path = '' as $$
declare
  cur text := fields ->> 'cost_currency';
begin
  if jsonb_typeof(fields) <> 'object' or exists (select 1 from jsonb_object_keys(fields) k
      where k not in ('title', 'day', 'starts_at', 'ends_at', 'place', 'link', 'note', 'going', 'cost', 'cost_currency')) then
    perform trip.refuse('Something went wrong. Try again.');
  end if;
  if cur is not null and not exists (select 1 from trip.trips t where t.id = trip and cur in (t.home_currency, t.local_currency)) then
    perform trip.refuse('Use the trip''s own currency for costs.');
  end if;
  if fields ? 'going' and jsonb_typeof(fields -> 'going') = 'array' and exists (
      select 1 from jsonb_array_elements_text(fields -> 'going') g
      where not exists (select 1 from trip.people p where p.trip_id = trip and p.id::text = g)) then
    perform trip.refuse('Only people on the trip can be going.');
  end if;
end;
$$;

-- Adds an item to an itinerary (after the others on its day). Returns its id.
create function trip.add_item(section uuid, fields jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s trip.sections := trip.require_section(section);
  r trip.items;
  new_id uuid;
begin
  if s.kind <> 'itinerary' then perform trip.refuse('That isn''t an itinerary.'); end if;
  perform trip.check_item_fields(s.trip_id, fields);
  r := jsonb_populate_record(null::trip.items, fields);
  insert into trip.items (section_id, trip_id, title, day, starts_at, ends_at, place, link, note, going, cost, cost_currency, position, made_by)
  values (section, s.trip_id, r.title, r.day, r.starts_at, r.ends_at, r.place, r.link, r.note, r.going, r.cost, r.cost_currency,
    coalesce((select max(i.position) + 1 from trip.items i where i.section_id = section and i.day is not distinct from r.day), 0),
    trip.me(s.trip_id))
  returning items.id into new_id;
  perform trip.note(s.trip_id, 'item.add', new_id, jsonb_build_object('section', section,
    'new', (select trip.item_json(i) from trip.items i where i.id = new_id)));
  return new_id;
end;
$$;

-- Changes the fields given (a field given as null is cleared; the others stay).
create function trip.edit_item(item uuid, fields jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  old trip.items;
  r trip.items;
  new jsonb;
begin
  select * into old from trip.items i where i.id = item;
  if not found then perform trip.refuse('That item isn''t there any more.'); end if;
  perform trip.require_section(old.section_id);
  perform trip.check_item_fields(old.trip_id, fields);
  r := jsonb_populate_record(old, fields);
  update trip.items i set title = r.title, day = r.day, starts_at = r.starts_at, ends_at = r.ends_at, place = r.place,
    link = r.link, note = r.note, going = r.going, cost = r.cost, cost_currency = r.cost_currency,
    position = case when r.day is distinct from old.day
      then coalesce((select max(x.position) + 1 from trip.items x where x.section_id = old.section_id and x.day is not distinct from r.day), 0)
      else i.position end,
    updated_at = now()
  where i.id = item returning trip.item_json(i) into new;
  if new is distinct from trip.item_json(old) then
    perform trip.note(old.trip_id, 'item.edit', item, jsonb_build_object('section', old.section_id, 'old', trip.item_json(old), 'new', new));
  end if;
end;
$$;

-- Moves an item up (-1) or down (+1) among those on its day.
create function trip.move_item(item uuid, step int) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i trip.items;
  other trip.items;
begin
  select * into i from trip.items x where x.id = item;
  if not found then perform trip.refuse('That item isn''t there any more.'); end if;
  perform trip.require_section(i.section_id);
  select * into other from trip.items x where x.section_id = i.section_id and x.day is not distinct from i.day and x.id <> i.id
    and (case when step < 0 then (x.position, x.id::text) < (i.position, i.id::text) else (x.position, x.id::text) > (i.position, i.id::text) end)
  order by case when step < 0 then x.position end desc, case when step < 0 then x.id::text end desc,
    case when step >= 0 then x.position end, case when step >= 0 then x.id::text end
  limit 1;
  if not found then return; end if;
  update trip.items x set position = case when x.id = i.id then other.position else i.position end
  where x.id in (i.id, other.id);
  -- the same position (made at once): make them differ in the asked order
  if other.position = i.position then
    update trip.items x set position = x.position + case when x.id = i.id then (case when step < 0 then 0 else 1 end)
      else (case when step < 0 then 1 else 0 end) end
    where x.id in (i.id, other.id);
  end if;
  perform trip.note(i.trip_id, 'item.move', item, jsonb_build_object('section', i.section_id, 'step', step));
end;
$$;

create function trip.delete_item(item uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i trip.items;
begin
  select * into i from trip.items x where x.id = item;
  if not found then return; end if;
  perform trip.require_section(i.section_id);
  perform trip.note(i.trip_id, 'item.delete', item, jsonb_build_object('section', i.section_id, 'old', trip.item_json(i)));
  delete from trip.items x where x.id = item;
end;
$$;

-- This person marks an item "not going" or "not interested" for themselves, or (null) takes it back. Archived trips
-- and locked sections don't stop it: it's about the person, not the plan.
create function trip.opt_out(item uuid, kind text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t uuid := (select i.trip_id from trip.items i where i.id = item);
  person uuid;
begin
  if t is null then perform trip.refuse('That item isn''t there any more.'); end if;
  person := trip.me(t);
  if person is null then perform trip.refuse('Only people on this trip can do that.'); end if;
  if kind is null then
    delete from trip.optouts o where o.item_id = item and o.person_id = person;
  else
    insert into trip.optouts (item_id, person_id, trip_id, kind) values (item, person, t, kind)
    on conflict (item_id, person_id) do update set kind = excluded.kind, at = now()
    where trip.optouts.kind <> excluded.kind;
  end if;
  if found then perform trip.note(t, 'item.opt_out', item, jsonb_build_object('kind', kind)); end if;
end;
$$;

-- ---------- reading ----------

grant select on trip.sections, trip.items, trip.optouts to authenticated;
create policy "people on the trip read its sections" on trip.sections for select to authenticated using ((select trip.is_member(trip_id)));
create policy "people on the trip read its items" on trip.items for select to authenticated using ((select trip.is_member(trip_id)));
create policy "people on the trip read its opt-outs" on trip.optouts for select to authenticated using ((select trip.is_member(trip_id)));

revoke execute on all functions in schema trip from public;
grant execute on function trip.me(uuid), trip.is_member(uuid), trip.is_planner(uuid),
  trip.make_trip(text, text, text, date, date, text), trip.edit_trip(uuid, text, text, date, date, text, text, numeric),
  trip.archive_trip(uuid, boolean), trip.join_link(uuid), trip.new_join_code(uuid),
  trip.add_person(uuid, text, text), trip.edit_person(uuid, text, text), trip.remove_person(uuid, boolean),
  trip.free_person(uuid, boolean), trip.set_planner(uuid, boolean),
  trip.join_info(text), trip.claim(text, uuid), trip.release(uuid), trip.handover_code(uuid), trip.take_over(text),
  trip.my_trips(),
  trip.add_section(uuid, text, text), trip.edit_section(uuid, text, boolean), trip.order_sections(uuid, uuid[]),
  trip.lock_section(uuid, boolean), trip.delete_section(uuid), trip.save_note(uuid, int, text),
  trip.add_item(uuid, jsonb), trip.edit_item(uuid, jsonb), trip.move_item(uuid, int), trip.delete_item(uuid),
  trip.opt_out(uuid, text) to authenticated;
grant execute on function trip.join_info(text) to anon;
