-- Trip (apps/trip/, planned in apps/_trip-plan.md): one page per trip for a group: the chat, notes, itinerary, budget
-- and expenses in one place. This first migration is the trip itself, its people, joining and the log; the sections
-- come in their own migrations.
--   trips: made by an account (anonymous sign-ins can't), who becomes its first planner. A title, an emoji, optional
--     dates, a home currency and an optional local one with a rate typed by hand (home per 1 local). A planner can
--     archive it (read-only) and bring it back.
--   people: the names on the trip, added by its planners (only planners add people). Nobody needs an account: the
--     join link (`?t=<join code>`) shows the names (join_info) and a device signs in anonymously and claims one
--     (claim). A claimed name is taken: only a planner can free it (lost phone), or its device let it go (release).
--     An account can be linked to a name too: by claiming it signed in, by making an account on the claimed
--     device (same user id), or with a hand-over code made on the claimed device (handover_code, then take_over
--     signed in to the account). Planners are people with a linked account; a trip keeps at least one.
--   log: every change, made in the same step by the function that makes it (nobody can write or change it), with
--     who did it and the old and new values. Only the trip's planners read it.
-- All changes go through the functions below (tables are read-only to the API). Refusals carry errcode RCTRP and a
-- message written to be shown.

create schema trip;
grant usage on schema trip to anon, authenticated;

-- ---------- tables ----------

create table trip.trips (
  id uuid primary key default gen_random_uuid(),
  title text not null check (title = btrim(title) and char_length(title) between 1 and 60
    and title !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]'),
  emoji text not null default '🧳' check (char_length(emoji) between 1 and 16
    and emoji !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]'),
  starts_on date,
  ends_on date,
  home_currency text not null default 'PHP' check (home_currency ~ '^[A-Z]{3}$'),
  local_currency text check (local_currency ~ '^[A-Z]{3}$' and local_currency <> home_currency),
  local_rate numeric(18, 6) check (local_rate > 0),
  join_code text not null unique,               -- in the join link; only planners read it (join_link)
  made_by uuid not null references core.accounts (id),
  made_at timestamptz not null default now(),
  archived_at timestamptz,                      -- set: read-only
  check (ends_on >= starts_on),
  check ((local_currency is null) = (local_rate is null))
);

create table trip.people (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trip.trips (id) on delete cascade,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 24
    and name !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]'),
  icon text not null default '👤' check (char_length(icon) between 1 and 16
    and icon !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]'),
  user_id uuid,                                 -- the device that claimed the name (maybe an anonymous sign-in)
  account_id uuid references core.accounts (id),   -- the account linked to it
  taken boolean generated always as (user_id is not null or account_id is not null) stored,
  planner boolean not null default false check (not planner or account_id is not null),
  added_at timestamptz not null default now(),
  removed_at timestamptz                        -- set: off the trip (their things stay); a planner can bring them back
);
create index on trip.people (trip_id);
create index on trip.people (user_id);
create index on trip.people (account_id);
create unique index people_one_name on trip.people (trip_id, lower(name)) where removed_at is null;
create unique index people_one_device on trip.people (trip_id, user_id) where removed_at is null;
create unique index people_one_account on trip.people (trip_id, account_id) where removed_at is null;

create table trip.handovers (
  person_id uuid primary key references trip.people (id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null default now() + interval '1 day'
);

create table trip.log (
  id bigint generated always as identity primary key,
  trip_id uuid not null references trip.trips (id) on delete cascade,
  person_id uuid references trip.people (id),   -- who did it, as a person on the trip (null: not one yet)
  actor uuid not null,                          -- their sign-in
  action text not null,                         -- e.g. 'trip.edit', 'person.claim'
  target uuid,                                  -- what it's about (a person…)
  detail jsonb,                                 -- old and new values: { "old": {…}, "new": {…} }, or other facts
  at timestamptz not null default now()
);
create index on trip.log (trip_id, id);

alter table trip.trips enable row level security;
alter table trip.people enable row level security;
alter table trip.handovers enable row level security;
alter table trip.log enable row level security;

-- ---------- who may do what ----------

-- The signed-in user's person on this trip (by device or linked account), or null.
create function trip.me(trip uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select p.id from trip.people p
  where p.trip_id = trip and p.removed_at is null and core.is_active()
    and (p.user_id = (select auth.uid()) or p.account_id = (select auth.uid()))
  order by (p.account_id = (select auth.uid())) desc nulls last
  limit 1;
$$;

create function trip.is_member(trip uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select trip.me(trip) is not null;
$$;

-- A planner: a person on the trip marked planner, signed in to their linked account.
create function trip.is_planner(trip uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select core.is_active() and exists (select 1 from trip.people p where p.trip_id = trip and p.removed_at is null
    and p.planner and p.account_id = (select auth.uid()));
$$;

create function trip.refuse(message text) returns void
language plpgsql volatile set search_path = '' as $$
begin
  raise exception '%', message using errcode = 'RCTRP';
end;
$$;

create function trip.require_member(trip uuid) returns void
language plpgsql stable set search_path = '' as $$
begin
  if not trip.is_member(trip) then perform trip.refuse('Only people on this trip can do that.'); end if;
end;
$$;

-- A planner, and (unless `archived_ok`) the trip isn't archived.
create function trip.require_planner(trip uuid, archived_ok boolean default false) returns void
language plpgsql stable set search_path = '' as $$
begin
  if not trip.is_planner(trip) then perform trip.refuse('Only the trip''s planners can do that.'); end if;
  if not archived_ok and exists (select 1 from trip.trips t where t.id = trip and t.archived_at is not null) then
    perform trip.refuse('This trip is archived. A planner can bring it back first.');
  end if;
end;
$$;

-- The person and their trip, for a function given a person id; refused if there's no such person.
create function trip.person_trip(person uuid) returns uuid
language plpgsql stable set search_path = '' as $$
declare
  t uuid := (select p.trip_id from trip.people p where p.id = person);
begin
  if t is null then perform trip.refuse('There''s no such person on this trip.'); end if;
  return t;
end;
$$;

create function trip.note(trip uuid, action text, target uuid default null, detail jsonb default null) returns void
language sql volatile set search_path = '' as $$
  insert into trip.log (trip_id, person_id, actor, action, target, detail)
  values (trip, trip.me(trip), (select auth.uid()), action, target, detail);
$$;

create function trip.person_json(p trip.people) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('name', p.name, 'icon', p.icon, 'planner', p.planner, 'removed', p.removed_at is not null);
$$;

create function trip.trip_json(t trip.trips) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('title', t.title, 'emoji', t.emoji, 'starts_on', t.starts_on, 'ends_on', t.ends_on,
    'home_currency', t.home_currency, 'local_currency', t.local_currency, 'local_rate', t.local_rate);
$$;

-- ---------- trips ----------

-- An account makes a trip and is its first planner, under `my_name`. Returns the trip's id.
create function trip.make_trip(title text, my_name text, emoji text default null, starts_on date default null,
  ends_on date default null, home_currency text default 'PHP') returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  new_id uuid;
begin
  if not exists (select 1 from core.accounts a where a.id = me and a.active) then
    perform trip.refuse('Sign in to your account to make a trip.');
  end if;
  insert into trip.trips (title, emoji, starts_on, ends_on, home_currency, join_code, made_by)
  values (title, coalesce(nullif(btrim(emoji), ''), '🧳'), starts_on, ends_on, coalesce(home_currency, 'PHP'), core.new_code(), me)
  returning trips.id into new_id;
  insert into trip.people (trip_id, name, user_id, account_id, planner) values (new_id, my_name, me, me, true);
  perform trip.note(new_id, 'trip.make', new_id, jsonb_build_object('new', (select trip.trip_json(t) from trip.trips t where t.id = new_id)));
  return new_id;
end;
$$;

-- Planners change the trip's details (all of them at once, as the form shows them).
create function trip.edit_trip(trip uuid, title text, emoji text, starts_on date, ends_on date, home_currency text,
  local_currency text default null, local_rate numeric default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  old jsonb;
  new jsonb;
begin
  perform trip.require_planner(trip);
  select trip.trip_json(t) into old from trip.trips t where t.id = trip;
  update trip.trips t set title = edit_trip.title, emoji = coalesce(nullif(btrim(edit_trip.emoji), ''), '🧳'),
    starts_on = edit_trip.starts_on, ends_on = edit_trip.ends_on, home_currency = edit_trip.home_currency,
    local_currency = edit_trip.local_currency, local_rate = edit_trip.local_rate
  where t.id = trip returning trip.trip_json(t) into new;
  if new is distinct from old then perform trip.note(trip, 'trip.edit', trip, jsonb_build_object('old', old, 'new', new)); end if;
end;
$$;

-- Planners archive the trip (read-only for everyone) or bring it back.
create function trip.archive_trip(trip uuid, archived boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform trip.require_planner(trip, true);
  update trip.trips t set archived_at = case when archived then coalesce(t.archived_at, now()) end
  where t.id = trip and (t.archived_at is null) = archived;
  if found then perform trip.note(trip, case when archived then 'trip.archive' else 'trip.unarchive' end, trip); end if;
end;
$$;

-- The join link's code, for planners to share.
create function trip.join_link(trip uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  perform trip.require_planner(trip, true);
  return (select t.join_code from trip.trips t where t.id = trip);
end;
$$;

-- A new join code: the old link stops working (people already on the trip stay). Returns it.
create function trip.new_join_code(trip uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  code text := core.new_code();
begin
  perform trip.require_planner(trip, true);
  update trip.trips t set join_code = code where t.id = trip;
  perform trip.note(trip, 'trip.new_join_code', trip);
  return code;
end;
$$;

-- ---------- people (planners) ----------

create function trip.add_person(trip uuid, name text, icon text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  new_id uuid;
begin
  perform trip.require_planner(trip);
  if exists (select 1 from trip.people p where p.trip_id = trip and p.removed_at is null and lower(p.name) = lower(btrim(add_person.name))) then
    perform trip.refuse('There''s already someone with that name on this trip.');
  end if;
  insert into trip.people (trip_id, name, icon) values (trip, name, coalesce(nullif(btrim(icon), ''), '👤'))
  returning people.id into new_id;
  perform trip.note(trip, 'person.add', new_id, jsonb_build_object('new', (select trip.person_json(p) from trip.people p where p.id = new_id)));
  return new_id;
end;
$$;

-- Planners, or the person themselves.
create function trip.edit_person(person uuid, name text, icon text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t uuid := trip.person_trip(person);
  old jsonb;
  new jsonb;
begin
  if trip.me(t) is distinct from person then perform trip.require_planner(t);
  elsif exists (select 1 from trip.trips x where x.id = t and x.archived_at is not null) then
    perform trip.refuse('This trip is archived. A planner can bring it back first.');
  end if;
  if exists (select 1 from trip.people p where p.trip_id = t and p.id <> person and p.removed_at is null
      and lower(p.name) = lower(btrim(edit_person.name))) then
    perform trip.refuse('There''s already someone with that name on this trip.');
  end if;
  select trip.person_json(p) into old from trip.people p where p.id = person;
  update trip.people p set name = edit_person.name, icon = coalesce(nullif(btrim(edit_person.icon), ''), '👤')
  where p.id = person returning trip.person_json(p) into new;
  if new is distinct from old then perform trip.note(t, 'person.edit', person, jsonb_build_object('old', old, 'new', new)); end if;
end;
$$;

-- Off the trip (their things stay, and so does their name in them), or back on it.
create function trip.remove_person(person uuid, removed boolean default true) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t uuid := trip.person_trip(person);
  p trip.people;
begin
  perform trip.require_planner(t);
  select * into p from trip.people x where x.id = person;
  if (p.removed_at is not null) = removed then return; end if;
  if removed and p.planner then perform trip.refuse('Make them not a planner first.'); end if;
  if not removed and exists (select 1 from trip.people x where x.trip_id = t and x.removed_at is null and (lower(x.name) = lower(p.name)
      or x.user_id = p.user_id or x.account_id = p.account_id)) then
    perform trip.refuse('Someone on the trip has that name or device now. Change theirs first.');
  end if;
  update trip.people x set removed_at = case when removed then now() end where x.id = person;
  perform trip.note(t, case when removed then 'person.remove' else 'person.restore' end, person);
end;
$$;

-- A planner frees a name: its device (and, with `unlink`, its account) lets go, and someone can claim it again.
create function trip.free_person(person uuid, unlink boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t uuid := trip.person_trip(person);
  p trip.people;
begin
  perform trip.require_planner(t, true);
  select * into p from trip.people x where x.id = person;
  if unlink and p.planner then perform trip.refuse('Make them not a planner first.'); end if;
  update trip.people x set user_id = null, account_id = case when unlink then null else x.account_id end where x.id = person;
  delete from trip.handovers h where h.person_id = person;
  perform trip.note(t, 'person.free', person, jsonb_build_object('device', p.user_id is not null, 'account', unlink and p.account_id is not null));
end;
$$;

-- Planners make another planner (someone with a linked account), or stop being one; a trip keeps at least one.
create function trip.set_planner(person uuid, planner boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t uuid := trip.person_trip(person);
  p trip.people;
begin
  perform trip.require_planner(t, true);
  select * into p from trip.people x where x.id = person;
  if p.planner = planner then return; end if;
  if p.removed_at is not null then perform trip.refuse('They''re not on the trip.'); end if;
  if planner and p.account_id is null then perform trip.refuse('Only someone with an account linked can be a planner.'); end if;
  if not planner and not exists (select 1 from trip.people x where x.trip_id = t and x.id <> person and x.planner and x.removed_at is null) then
    perform trip.refuse('A trip needs at least one planner.');
  end if;
  update trip.people x set planner = set_planner.planner where x.id = person;
  perform trip.note(t, case when planner then 'person.planner' else 'person.not_planner' end, person);
end;
$$;

-- ---------- joining (anyone with the link) ----------

-- What the join link shows before anyone signs in: the trip and its names, which are taken. null: the code doesn't
-- work. { id, title, emoji, starts_on, ends_on, archived, people: [{ id, name, icon, taken }] }
create function trip.join_info(code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'title', t.title, 'emoji', t.emoji, 'starts_on', t.starts_on, 'ends_on', t.ends_on,
    'archived', t.archived_at is not null,
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'icon', p.icon, 'taken', p.taken)
      order by lower(p.name)) from trip.people p where p.trip_id = t.id and p.removed_at is null), '[]'))
  from trip.trips t where t.join_code = core.clean_code(code);
$$;

-- This device (signed in, anonymously or to an account) becomes a name on the trip, with the join code. Signed in to
-- an account, the account is linked to it too. Returns the trip's id.
create function trip.claim(code text, person uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  account boolean := exists (select 1 from core.accounts a where a.id = me and a.active);
  t uuid := (select x.id from trip.trips x where x.join_code = core.clean_code(code));
  p trip.people;
begin
  if me is null or not core.is_active() then perform trip.refuse('Sign in first.'); end if;
  if t is null then perform trip.refuse('That link doesn''t work any more. Ask the planner for a new one.'); end if;
  select * into p from trip.people x where x.id = person and x.trip_id = t and x.removed_at is null;
  if not found then perform trip.refuse('There''s no such person on this trip.'); end if;
  if trip.me(t) = person then return t; end if;
  if trip.me(t) is not null then perform trip.refuse('You''re already someone else on this trip. Let that name go first.'); end if;
  if p.user_id is not null or (p.account_id is not null and p.account_id <> me) then
    perform trip.refuse('Someone already took that name. If it''s you, ask a planner to free it.');
  end if;
  update trip.people x set user_id = me, account_id = case when account then me else x.account_id end where x.id = person;
  perform trip.note(t, 'person.claim', person, jsonb_build_object('account', account));
  return t;
end;
$$;

-- This signed-in user stops being their name on the trip (to pick another, or leave): this device lets go of it, and
-- signed in to the linked account, the account is unlinked too. Planners stop being one first.
create function trip.release(trip uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  person uuid := trip.me(trip);
  p trip.people;
begin
  if person is null then return; end if;
  select * into p from trip.people x where x.id = person;
  if p.account_id = me and p.planner then perform trip.refuse('Stop being a planner first.'); end if;
  perform trip.note(trip, 'person.release', person, jsonb_build_object('account', p.account_id = me));
  update trip.people x set user_id = case when x.user_id = me then null else x.user_id end,
    account_id = case when x.account_id = me then null else x.account_id end
  where x.id = person;
end;
$$;

-- On the claimed device, before signing in to an existing account: a one-time code (valid a day) that links that
-- account to this name (take_over). A new one replaces the old.
create function trip.handover_code(trip uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  person uuid := trip.me(trip);
  code text := core.new_code();
begin
  if person is null then perform trip.refuse('Only people on this trip can do that.'); end if;
  insert into trip.handovers (person_id, code_hash) values (person, core.hash_code(code))
  on conflict (person_id) do update set code_hash = excluded.code_hash, expires_at = now() + interval '1 day';
  return code;
end;
$$;

-- Signed in to an account: link it to the name the hand-over code was made for. Returns the trip's id.
create function trip.take_over(code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  person uuid;
  t uuid;
begin
  if not exists (select 1 from core.accounts a where a.id = me and a.active) then
    perform trip.refuse('Sign in to your account first.');
  end if;
  select h.person_id into person from trip.handovers h where h.code_hash = core.hash_code(code) and h.expires_at > now();
  if person is null then perform trip.refuse('That code doesn''t work any more.'); end if;
  delete from trip.handovers h where h.person_id = person;
  select p.trip_id into t from trip.people p where p.id = person and p.removed_at is null;
  if t is null then perform trip.refuse('That name isn''t on the trip any more.'); end if;
  if trip.me(t) = person then return t; end if;
  if trip.me(t) is not null then perform trip.refuse('Your account is already someone else on this trip.'); end if;
  if exists (select 1 from trip.people p where p.id = person and p.account_id is not null and p.account_id <> me) then
    perform trip.refuse('Another account is already linked to that name.');
  end if;
  update trip.people p set account_id = me where p.id = person;
  perform trip.note(t, 'person.link', person);
  return t;
end;
$$;

-- ---------- reading ----------

-- The trips this user is on (by device or account), newest first: [{ id, title, emoji, starts_on, ends_on, archived,
-- me, planner }].
create function trip.my_trips() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'emoji', t.emoji, 'starts_on', t.starts_on,
    'ends_on', t.ends_on, 'archived', t.archived_at is not null, 'me', trip.me(t.id), 'planner', trip.is_planner(t.id))
    order by t.starts_on desc nulls first, t.made_at desc), '[]')
  from trip.trips t where trip.is_member(t.id);
$$;

grant select (id, title, emoji, starts_on, ends_on, home_currency, local_currency, local_rate, made_by, made_at, archived_at)
  on trip.trips to authenticated;
grant select (id, trip_id, name, icon, taken, planner, added_at, removed_at) on trip.people to authenticated;
grant select on trip.log to authenticated;
create policy "people on the trip read it" on trip.trips for select to authenticated using ((select trip.is_member(id)));
create policy "people on the trip read its people" on trip.people for select to authenticated using ((select trip.is_member(trip_id)));
create policy "planners read the log" on trip.log for select to authenticated using ((select trip.is_planner(trip_id)));
-- (handovers: nobody reads it through the API.)

revoke execute on all functions in schema trip from public;
alter default privileges in schema trip revoke execute on functions from public;
grant execute on function trip.me(uuid), trip.is_member(uuid), trip.is_planner(uuid),
  trip.make_trip(text, text, text, date, date, text), trip.edit_trip(uuid, text, text, date, date, text, text, numeric),
  trip.archive_trip(uuid, boolean), trip.join_link(uuid), trip.new_join_code(uuid),
  trip.add_person(uuid, text, text), trip.edit_person(uuid, text, text), trip.remove_person(uuid, boolean),
  trip.free_person(uuid, boolean), trip.set_planner(uuid, boolean),
  trip.join_info(text), trip.claim(text, uuid), trip.release(uuid), trip.handover_code(uuid), trip.take_over(text),
  trip.my_trips() to authenticated;
grant execute on function trip.join_info(text) to anon;
