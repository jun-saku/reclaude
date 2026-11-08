-- Trip: the chat (apps/_trip-plan.md). One chat per trip, and a thread of comments on any itinerary item (`about`).
--   messages: someone on the trip writes (up to 2000 characters); a reply quotes another message; @mentions name people
--     on the trip. Writers edit their own; writers and planners delete (the text goes, a "deleted" mark stays). Sending
--     isn't logged (too many); edits and deletes are, with the old text.
--   reactions: an emoji per person per message (several emoji allowed), on or off.
--   changes: one row per trip whose version moves on with every logged change, so a page can follow the trip live
--     (Supabase Realtime) without reading the trips table itself.
-- Messages, reactions and changes are published to Realtime; row level security decides who hears what.

create table trip.messages (
  id bigint generated always as identity primary key,
  trip_id uuid not null references trip.trips (id) on delete cascade,
  person_id uuid not null references trip.people (id),
  about uuid references trip.items (id) on delete cascade,   -- an item's thread; null: the trip's chat
  reply_to bigint references trip.messages (id) on delete set null,
  body text not null,
  mentions uuid[] not null default '{}' check (cardinality(mentions) <= 50),
  at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  check (translate(body, E'\n\t', '') !~ '[[:cntrl:]]'),
  check ((deleted_at is null and char_length(btrim(body)) between 1 and 2000) or (deleted_at is not null and body = ''))
);
create index on trip.messages (trip_id, id);
create index on trip.messages (about, id);

create table trip.reactions (
  message_id bigint not null references trip.messages (id) on delete cascade,
  person_id uuid not null references trip.people (id),
  trip_id uuid not null references trip.trips (id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 16 and emoji !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]'),
  at timestamptz not null default now(),
  primary key (message_id, person_id, emoji)
);
create index on trip.reactions (trip_id);

create table trip.changes (
  trip_id uuid primary key references trip.trips (id) on delete cascade,
  version bigint not null default 0,
  at timestamptz not null default now()
);
insert into trip.changes (trip_id, version) select id, version from trip.trips;

alter table trip.messages enable row level security;
alter table trip.reactions enable row level security;
alter table trip.changes enable row level security;

-- Every logged change also moves the trip's row in changes on (which Realtime sends to the trip's people).
create or replace function trip.note(trip uuid, action text, target uuid default null, detail jsonb default null) returns void
language sql volatile set search_path = '' as $$
  insert into trip.log (trip_id, person_id, actor, action, target, detail)
  values (trip, trip.me(trip), (select auth.uid()), action, target, detail);
  update trip.trips t set version = t.version + 1 where t.id = trip;
  insert into trip.changes (trip_id, version) values (trip, 1)
  on conflict (trip_id) do update set version = trip.changes.version + 1, at = now();
$$;

-- ---------- messages ----------

-- Sends a message to the trip's chat, or (about) an item's thread. Returns its id.
create function trip.send_message(trip uuid, body text, reply_to bigint default null, about uuid default null,
  mentions uuid[] default '{}') returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  person uuid := trip.require_editor(trip);
  new_id bigint;
begin
  if about is not null and not exists (select 1 from trip.items i where i.id = about and i.trip_id = trip) then
    perform trip.refuse('That item isn''t there any more.');
  end if;
  if reply_to is not null and not exists (select 1 from trip.messages m where m.id = send_message.reply_to and m.trip_id = trip) then
    perform trip.refuse('That message isn''t there any more.');
  end if;
  insert into trip.messages (trip_id, person_id, about, reply_to, body, mentions)
  values (trip, person, about, reply_to, btrim(body, E' \n\t'),
    coalesce((select array_agg(distinct p.id) from trip.people p where p.trip_id = trip and p.id = any (coalesce(mentions, '{}'))), '{}'))
  returning messages.id into new_id;
  return new_id;
end;
$$;

-- The writer changes their message.
create function trip.edit_message(message bigint, body text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  m trip.messages;
begin
  select * into m from trip.messages x where x.id = message;
  if not found or m.deleted_at is not null then perform trip.refuse('That message isn''t there any more.'); end if;
  if trip.require_editor(m.trip_id) <> m.person_id then perform trip.refuse('Only whoever wrote it can change it.'); end if;
  if m.body = btrim(body, E' \n\t') then return; end if;
  update trip.messages x set body = btrim(edit_message.body, E' \n\t'), edited_at = now() where x.id = message;
  perform trip.note(m.trip_id, 'message.edit', m.about, jsonb_build_object('message', message, 'old', m.body, 'new', btrim(body, E' \n\t')));
end;
$$;

-- The writer or a planner deletes a message: its text goes, and its reactions.
create function trip.delete_message(message bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
  m trip.messages;
begin
  select * into m from trip.messages x where x.id = message;
  if not found or m.deleted_at is not null then return; end if;
  if trip.require_editor(m.trip_id) <> m.person_id and not trip.is_planner(m.trip_id) then
    perform trip.refuse('Only whoever wrote it, or a planner, can delete it.');
  end if;
  perform trip.note(m.trip_id, 'message.delete', m.about, jsonb_build_object('message', message, 'by', m.person_id, 'old', m.body));
  update trip.messages x set body = '', mentions = '{}', deleted_at = now() where x.id = message;
  delete from trip.reactions r where r.message_id = message;
end;
$$;

-- Puts this person's emoji on a message, or takes it off.
create function trip.react(message bigint, emoji text, on_off boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  m trip.messages;
  person uuid;
begin
  select * into m from trip.messages x where x.id = message;
  if not found or m.deleted_at is not null then perform trip.refuse('That message isn''t there any more.'); end if;
  person := trip.require_editor(m.trip_id);
  if on_off then
    insert into trip.reactions (message_id, person_id, trip_id, emoji) values (message, person, m.trip_id, btrim(emoji)) on conflict do nothing;
  else
    delete from trip.reactions r where r.message_id = message and r.person_id = person and r.emoji = btrim(react.emoji);
  end if;
end;
$$;

-- ---------- reading, and Realtime ----------

grant select on trip.messages, trip.reactions, trip.changes to authenticated;
create policy "people on the trip read its messages" on trip.messages for select to authenticated using ((select trip.is_member(trip_id)));
create policy "people on the trip read its reactions" on trip.reactions for select to authenticated using ((select trip.is_member(trip_id)));
create policy "people on the trip follow its changes" on trip.changes for select to authenticated using ((select trip.is_member(trip_id)));

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table trip.messages, trip.reactions, trip.changes;
  end if;
end $$;

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
  trip.opt_out(uuid, text),
  trip.send_message(uuid, text, bigint, uuid, uuid[]), trip.edit_message(bigint, text), trip.delete_message(bigint),
  trip.react(bigint, text, boolean) to authenticated;
grant execute on function trip.join_info(text) to anon;
