-- Trip: push notifications (apps/_trip-plan.md). A phone that turns them on keeps its Web Push subscription here; when
-- a message is sent, the database works out who should hear about it and hands the game server (worker/, which holds
-- the push signing keys) one request with their subscriptions and the text. Nothing else leaves the database.
--   push_subs: one per phone (endpoint), for the signed-in user who saved it (anonymous or an account). Written only
--     through save_push / drop_push; nobody reads it through the API.
--   push_prefs: per person on a trip, what notifies them: @mentions, replies to them, comments on items they added
--     (all on by default) and every chat message (off).
--   The sender's address and its shared secret are Supabase Vault secrets, set once in the dashboard:
--     select vault.create_secret('<a long random secret>', 'trip_push_secret');
--   (the same secret as the game server's PUSH_SECRET; optionally 'trip_push_url', by default the live game server).
--   Without the secret (local, CI) nothing is sent.

create extension if not exists pg_net;

create table trip.push_subs (
  endpoint text primary key check (char_length(endpoint) <= 1000 and endpoint ~ '^https://[^\s<>"]+$'),
  user_id uuid not null,
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{16,32}$'),
  saved_at timestamptz not null default now()
);
create index on trip.push_subs (user_id);

create table trip.push_prefs (
  person_id uuid primary key references trip.people (id) on delete cascade,
  mentions boolean not null default true,
  replies boolean not null default true,
  comments boolean not null default true,
  all_messages boolean not null default false
);

alter table trip.push_subs enable row level security;
alter table trip.push_prefs enable row level security;
-- (Neither is readable through the API: push_settings() says what a person may know.)

-- ---------- this phone's subscription ----------

-- Saves this phone's subscription for the signed-in user (a phone moving to another sign-in takes it along).
create function trip.save_push(endpoint text, p256dh text, auth text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not core.is_active() then perform trip.refuse('Sign in first.'); end if;
  if (select count(*) from trip.push_subs s where s.user_id = (select auth.uid())) >= 10
      and not exists (select 1 from trip.push_subs s where s.endpoint = save_push.endpoint) then
    perform trip.refuse('Too many phones get notifications for you. Turn them off on one first.');
  end if;
  insert into trip.push_subs (endpoint, user_id, p256dh, auth) values (endpoint, (select auth.uid()), p256dh, auth)
  on conflict on constraint push_subs_pkey do update set user_id = excluded.user_id, p256dh = excluded.p256dh,
    auth = excluded.auth, saved_at = now();
end;
$$;

create function trip.drop_push(endpoint text) returns void
language sql security definer set search_path = '' as $$
  delete from trip.push_subs s where s.endpoint = drop_push.endpoint and s.user_id = (select auth.uid());
$$;

-- This person's settings on the trip: { mentions, replies, comments, all_messages, phones } (phones: how many of the
-- signed-in user's phones get notifications).
create function trip.push_settings(trip uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  person uuid := trip.me(trip);
  p trip.push_prefs;
begin
  if person is null then perform trip.refuse('Only people on this trip can do that.'); end if;
  select * into p from trip.push_prefs x where x.person_id = person;
  return jsonb_build_object('mentions', coalesce(p.mentions, true), 'replies', coalesce(p.replies, true),
    'comments', coalesce(p.comments, true), 'all_messages', coalesce(p.all_messages, false),
    'phones', (select count(*) from trip.push_subs s where s.user_id = (select auth.uid())));
end;
$$;

create function trip.set_push_settings(trip uuid, mentions boolean, replies boolean, comments boolean, all_messages boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  person uuid := trip.me(trip);
begin
  if person is null then perform trip.refuse('Only people on this trip can do that.'); end if;
  insert into trip.push_prefs (person_id, mentions, replies, comments, all_messages)
  values (person, coalesce(mentions, true), coalesce(replies, true), coalesce(comments, true), coalesce(all_messages, false))
  on conflict (person_id) do update set mentions = excluded.mentions, replies = excluded.replies,
    comments = excluded.comments, all_messages = excluded.all_messages;
end;
$$;

-- ---------- sending ----------

-- Who hears about a new message, and on which phones: [{ endpoint, p256dh, auth }]. Not the writer; people still on
-- the trip; by their settings.
create function trip.push_targets(m trip.messages) returns jsonb
language sql stable security definer set search_path = '' as $$
  with who as (
    select p.id, p.user_id, p.account_id from trip.people p left join trip.push_prefs pp on pp.person_id = p.id
    where p.trip_id = m.trip_id and p.removed_at is null and p.id <> m.person_id and (
      (coalesce(pp.mentions, true) and p.id = any (m.mentions))
      or (coalesce(pp.replies, true) and m.reply_to is not null
        and p.id = (select x.person_id from trip.messages x where x.id = m.reply_to))
      or (coalesce(pp.comments, true) and m.about is not null
        and p.id = (select i.made_by from trip.items i where i.id = m.about))
      or (coalesce(pp.all_messages, false) and m.about is null))
  )
  select coalesce(jsonb_agg(distinct jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]')
  from who join trip.push_subs s on s.user_id = who.user_id or s.user_id = who.account_id;
$$;

-- After a message is sent: one request to the game server with its targets and text (when the secret is set).
create function trip.push_message() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  secret text := (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'trip_push_secret');
  url text := coalesce((select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'trip_push_url'),
    'https://play.reclaude.junsaku.dev/push/send');
  targets jsonb;
  t trip.trips;
  item text;
begin
  if secret is null then return null; end if;
  targets := trip.push_targets(new);
  if jsonb_array_length(targets) = 0 then return null; end if;
  select * into t from trip.trips x where x.id = new.trip_id;
  item := (select i.title from trip.items i where i.id = new.about);
  perform net.http_post(
    url := url,
    body := jsonb_build_object('pushes', targets, 'payload', jsonb_build_object(
      'title', (select p.name from trip.people p where p.id = new.person_id) || ' · ' || t.title,
      'body', case when item is not null then 'On ' || item || ': ' else '' end || left(new.body, 160),
      'url', '/apps/trip/?id=' || t.id || '&chat' || case when new.about is not null then '&about=' || new.about else '' end,
      'tag', 'trip-' || t.id || coalesce('-' || new.about, ''))),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || secret),
    timeout_milliseconds := 5000);
  return null;
exception when others then
  return null; -- a notification never stops a message
end;
$$;

create trigger push_message after insert on trip.messages for each row execute function trip.push_message();

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
  trip.react(bigint, text, boolean),
  trip.save_push(text, text, text), trip.drop_push(text), trip.push_settings(uuid),
  trip.set_push_settings(uuid, boolean, boolean, boolean, boolean) to authenticated;
grant execute on function trip.join_info(text) to anon;
