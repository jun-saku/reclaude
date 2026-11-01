-- Pickleball (apps/pickleball/): rotation for a group playing on a few courts.
--   managers: accounts with the pickleball `manager` role (given in the admin panel). Only they make players, clubs
--     and sessions.
--   players: a name and an icon (👤 by default), no account needed. Any manager adds any player to their clubs; the
--     player's maker and the managers of a club they're in edit them. (Linking an account to players comes later.)
--   clubs: a list of players. Whoever makes one manages it, and can add other managers (accounts with the manager
--     role) or remove them; a club keeps at least one.
--   sessions: started by a manager, from a club (its managers run it too) or from scratch. Courts, the algorithm
--     (worked out on the runner's phone; its queue, breaks and pairs are kept here as `state`), who's here (club
--     players and guests), and matches: doubles by default, either side may be one player, times recorded,
--     score optional.
--   helpers: whoever has the session's helper code (a QR the runner shows) may run the queue and the courts, not the
--     settings or the players. No account needed: an anonymous sign-in is enough. A new code drops the old helpers;
--     the session's end drops them all.
--   the live view: anyone with the session's watch code sees the courts and the queue (pickleball.watch, also for
--     anonymous visitors), and nothing else.
-- All changes go through the functions below (tables are read-only to the API), and each is in pickleball.log.
-- Refusals carry errcode RCPKL and a message written to be shown.

create schema pickleball;
grant usage on schema pickleball to anon, authenticated;

insert into core.apps (name, title) values ('pickleball', 'Pickleball');
insert into core.app_role_names (app, role, title) values ('pickleball', 'manager', 'Manager');

-- ---------- tables ----------

create table pickleball.players (
  id uuid primary key default gen_random_uuid(),
  name text not null check (name = btrim(name) and char_length(name) between 1 and 24
    and name !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]'),
  icon text not null default '👤' check (char_length(icon) between 1 and 16
    and icon !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]'),
  made_by uuid not null references core.accounts (id),
  made_at timestamptz not null default now()
);

create table pickleball.clubs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (name = btrim(name) and char_length(name) between 1 and 40
    and name !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]'),
  made_by uuid not null references core.accounts (id),
  made_at timestamptz not null default now()
);

create table pickleball.club_managers (
  club_id uuid not null references pickleball.clubs (id) on delete cascade,
  user_id uuid not null references core.accounts (id),
  added_by uuid not null references core.accounts (id),
  added_at timestamptz not null default now(),
  primary key (club_id, user_id)
);

create table pickleball.club_players (
  club_id uuid not null references pickleball.clubs (id) on delete cascade,
  player_id uuid not null references pickleball.players (id),
  added_by uuid not null references core.accounts (id),
  added_at timestamptz not null default now(),
  primary key (club_id, player_id)
);

create table pickleball.sessions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid references pickleball.clubs (id) on delete set null,
  courts int not null check (courts between 1 and 20),
  algorithm text not null check (algorithm ~ '^[a-z][a-z_]{0,19}$'),
  state jsonb not null default '{}' check (jsonb_typeof(state) = 'object' and pg_column_size(state) <= 20000),
  version int not null default 0,              -- +1 on every change of the queue, courts or players: the live view
                                               -- refreshes on it, and state is saved only on the version it read
  watch_code text not null unique,             -- in the live view's link: read-only
  helper_hash text,                            -- core.hash_code of the current helper code (null: none)
  started_by uuid not null references core.accounts (id),
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table pickleball.session_players (
  session_id uuid not null references pickleball.sessions (id) on delete cascade,
  player_id uuid not null references pickleball.players (id),
  here boolean not null default true,          -- false: left the session (their matches stay)
  added_at timestamptz not null default now(),
  primary key (session_id, player_id)
);

create table pickleball.session_helpers (
  session_id uuid not null references pickleball.sessions (id) on delete cascade,
  user_id uuid not null,                       -- a signed-in user, maybe anonymous (gone when the session ends)
  joined_at timestamptz not null default now(),
  primary key (session_id, user_id)
);

create table pickleball.matches (
  id bigint generated always as identity primary key,
  session_id uuid not null references pickleball.sessions (id) on delete cascade,
  court int not null check (court between 1 and 20),
  side_a uuid[] not null check (cardinality(side_a) between 1 and 2),
  side_b uuid[] not null check (cardinality(side_b) between 1 and 2),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  score_a int check (score_a between 0 and 99),
  score_b int check (score_b between 0 and 99)
);
create index on pickleball.matches (session_id, started_at);
create unique index matches_one_per_court on pickleball.matches (session_id, court) where ended_at is null;

create table pickleball.log (
  id bigint generated always as identity primary key,
  session_id uuid references pickleball.sessions (id) on delete cascade,
  club_id uuid references pickleball.clubs (id) on delete cascade,
  actor uuid not null,                          -- a manager, or a helper (maybe anonymous)
  action text not null,
  detail jsonb,
  at timestamptz not null default now()
);
create index on pickleball.log (session_id, id);

alter table pickleball.players enable row level security;
alter table pickleball.clubs enable row level security;
alter table pickleball.club_managers enable row level security;
alter table pickleball.club_players enable row level security;
alter table pickleball.sessions enable row level security;
alter table pickleball.session_players enable row level security;
alter table pickleball.session_helpers enable row level security;
alter table pickleball.matches enable row level security;
alter table pickleball.log enable row level security;

-- ---------- who may do what ----------

create function pickleball.is_manager() returns boolean
language sql stable security definer set search_path = '' as $$
  select core.has_app_role('pickleball', 'manager');
$$;

create function pickleball.manages_club(club uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select pickleball.is_manager() and exists (
    select 1 from pickleball.club_managers m where m.club_id = club and m.user_id = (select auth.uid()));
$$;

-- Runs the session: its starter, or a manager of its club (managers only).
create function pickleball.runs(session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select pickleball.is_manager() and exists (
    select 1 from pickleball.sessions s where s.id = session
      and (s.started_by = (select auth.uid()) or (s.club_id is not null and pickleball.manages_club(s.club_id))));
$$;

-- Runs the queue and the courts of an open session: its runners and its helpers.
create function pickleball.helps(session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select core.is_active() and exists (select 1 from pickleball.sessions s where s.id = session and s.ended_at is null)
    and (pickleball.runs(session) or exists (
      select 1 from pickleball.session_helpers h where h.session_id = session and h.user_id = (select auth.uid())));
$$;

create function pickleball.refuse(message text) returns void
language plpgsql volatile set search_path = '' as $$
begin
  raise exception '%', message using errcode = 'RCPKL';
end;
$$;

create function pickleball.require_manager() returns void
language plpgsql stable set search_path = '' as $$
begin
  if not pickleball.is_manager() then perform pickleball.refuse('Only a pickleball manager can do that.'); end if;
end;
$$;

create function pickleball.require_runner(session uuid) returns void
language plpgsql stable set search_path = '' as $$
begin
  if not pickleball.runs(session) then perform pickleball.refuse('Only the session''s managers can do that.'); end if;
  if exists (select 1 from pickleball.sessions s where s.id = session and s.ended_at is not null) then
    perform pickleball.refuse('This session has ended.');
  end if;
end;
$$;

create function pickleball.require_helper(session uuid) returns void
language plpgsql stable set search_path = '' as $$
begin
  if not pickleball.helps(session) then
    if exists (select 1 from pickleball.sessions s where s.id = session and s.ended_at is not null) then
      perform pickleball.refuse('This session has ended.');
    end if;
    perform pickleball.refuse('Only the session''s managers and helpers can do that.');
  end if;
end;
$$;

create function pickleball.note(session uuid, club uuid, action text, detail jsonb default null) returns void
language sql volatile set search_path = '' as $$
  insert into pickleball.log (session_id, club_id, actor, action, detail) values (session, club, (select auth.uid()), action, detail);
$$;

create function pickleball.bump(session uuid) returns void
language sql volatile set search_path = '' as $$
  update pickleball.sessions set version = version + 1 where id = session;
$$;

-- ---------- players ----------

create function pickleball.make_player(name text, icon text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  id uuid;
begin
  perform pickleball.require_manager();
  insert into pickleball.players (name, icon, made_by) values (name, coalesce(nullif(btrim(icon), ''), '👤'), (select auth.uid()))
  returning players.id into id;
  perform pickleball.note(null, null, 'made player', jsonb_build_object('player', id, 'name', name));
  return id;
end;
$$;

-- Its maker and the managers of any club it's in.
create function pickleball.edit_player(player uuid, name text, icon text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pickleball.require_manager();
  if not exists (select 1 from pickleball.players p where p.id = player and (p.made_by = (select auth.uid())
      or exists (select 1 from pickleball.club_players c where c.player_id = p.id and pickleball.manages_club(c.club_id)))) then
    perform pickleball.refuse('Only whoever added this player, or a manager of their club, can change them.');
  end if;
  update pickleball.players p set name = edit_player.name, icon = coalesce(nullif(btrim(edit_player.icon), ''), '👤')
  where p.id = player;
  perform pickleball.note(null, null, 'edited player', jsonb_build_object('player', player, 'name', name));
end;
$$;

-- ---------- clubs ----------

create function pickleball.make_club(name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  id uuid;
begin
  perform pickleball.require_manager();
  insert into pickleball.clubs (name, made_by) values (name, (select auth.uid())) returning clubs.id into id;
  insert into pickleball.club_managers (club_id, user_id, added_by) values (id, (select auth.uid()), (select auth.uid()));
  perform pickleball.note(null, id, 'made club', jsonb_build_object('name', name));
  return id;
end;
$$;

create function pickleball.require_club(club uuid) returns void
language plpgsql stable set search_path = '' as $$
begin
  if not pickleball.manages_club(club) then perform pickleball.refuse('Only this club''s managers can do that.'); end if;
end;
$$;

create function pickleball.rename_club(club uuid, name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pickleball.require_club(club);
  update pickleball.clubs c set name = rename_club.name where c.id = club;
  perform pickleball.note(null, club, 'renamed club', jsonb_build_object('name', name));
end;
$$;

create function pickleball.add_club_player(club uuid, player uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pickleball.require_club(club);
  if not exists (select 1 from pickleball.players p where p.id = player) then perform pickleball.refuse('There''s no such player.'); end if;
  insert into pickleball.club_players (club_id, player_id, added_by) values (club, player, (select auth.uid())) on conflict do nothing;
  if found then perform pickleball.note(null, club, 'added player', jsonb_build_object('player', player)); end if;
end;
$$;

create function pickleball.remove_club_player(club uuid, player uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pickleball.require_club(club);
  delete from pickleball.club_players c where c.club_id = club and c.player_id = player;
  if found then perform pickleball.note(null, club, 'removed player', jsonb_build_object('player', player)); end if;
end;
$$;

-- Another manager for the club: an active account with the pickleball manager role.
create function pickleball.add_club_manager(club uuid, target uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pickleball.require_club(club);
  if not exists (select 1 from core.accounts a where a.id = target and a.active and (
      exists (select 1 from core.app_roles r where r.user_id = target and r.app = 'pickleball' and r.role = 'manager')
      or exists (select 1 from core.roles r where r.user_id = target and r.role = 'superuser'))) then
    perform pickleball.refuse('Only an account with the pickleball manager role can manage a club.');
  end if;
  insert into pickleball.club_managers (club_id, user_id, added_by) values (club, target, (select auth.uid())) on conflict do nothing;
  if found then perform pickleball.note(null, club, 'added manager', jsonb_build_object('user', target)); end if;
end;
$$;

create function pickleball.remove_club_manager(club uuid, target uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pickleball.require_club(club);
  if not exists (select 1 from pickleball.club_managers m where m.club_id = club and m.user_id <> target) then
    perform pickleball.refuse('A club needs at least one manager.');
  end if;
  delete from pickleball.club_managers m where m.club_id = club and m.user_id = target;
  if found then perform pickleball.note(null, club, 'removed manager', jsonb_build_object('user', target)); end if;
end;
$$;

-- ---------- sessions (their runners) ----------

-- Starts a session, from a club (whose manager you are) or from none, with these players here. Returns its id.
create function pickleball.start_session(club uuid, courts int, algorithm text, players uuid[]) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  id uuid;
begin
  perform pickleball.require_manager();
  if club is not null then perform pickleball.require_club(club); end if;
  if exists (select 1 from unnest(coalesce(players, '{}')) p where not exists (select 1 from pickleball.players x where x.id = p)) then
    perform pickleball.refuse('There''s no such player.');
  end if;
  insert into pickleball.sessions (club_id, courts, algorithm, watch_code, started_by)
  values (club, courts, algorithm, core.new_code(), (select auth.uid())) returning sessions.id into id;
  insert into pickleball.session_players (session_id, player_id) select distinct id, p from unnest(coalesce(players, '{}')) p;
  perform pickleball.note(id, club, 'started session', jsonb_build_object('courts', courts, 'algorithm', algorithm));
  return id;
end;
$$;

create function pickleball.set_session(session uuid, courts int, algorithm text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pickleball.require_runner(session);
  if exists (select 1 from pickleball.matches m where m.session_id = session and m.ended_at is null and m.court > courts) then
    perform pickleball.refuse('A match is still on a court you''re removing.');
  end if;
  update pickleball.sessions s set courts = set_session.courts, algorithm = set_session.algorithm where s.id = session;
  perform pickleball.bump(session);
  perform pickleball.note(session, null, 'changed session', jsonb_build_object('courts', courts, 'algorithm', algorithm));
end;
$$;

-- A player arrives (any player: a club's, or a guest made with make_player) or leaves (here = false).
create function pickleball.set_here(session uuid, player uuid, here boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pickleball.require_runner(session);
  if not exists (select 1 from pickleball.players p where p.id = player) then perform pickleball.refuse('There''s no such player.'); end if;
  insert into pickleball.session_players (session_id, player_id, here) values (session, player, set_here.here)
  on conflict (session_id, player_id) do update set here = excluded.here;
  perform pickleball.bump(session);
  perform pickleball.note(session, null, case when here then 'player here' else 'player left' end, jsonb_build_object('player', player));
end;
$$;

-- A new helper code (shown once, as a QR); the old one and its helpers stop working.
create function pickleball.helper_code(session uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  code text := core.new_code();
begin
  perform pickleball.require_runner(session);
  update pickleball.sessions s set helper_hash = core.hash_code(code) where s.id = session;
  delete from pickleball.session_helpers h where h.session_id = session;
  perform pickleball.note(session, null, 'new helper code');
  return code;
end;
$$;

create function pickleball.end_session(session uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pickleball.require_runner(session);
  update pickleball.matches m set ended_at = now() where m.session_id = session and m.ended_at is null;
  update pickleball.sessions s set ended_at = now(), helper_hash = null, version = version + 1 where s.id = session;
  delete from pickleball.session_helpers h where h.session_id = session;
  perform pickleball.note(session, null, 'ended session');
end;
$$;

-- ---------- the queue and the courts (runners and helpers) ----------

-- Anyone signed in (anonymous too) with the helper code becomes a helper. Returns the watch code, for the view.
create function pickleball.become_helper(session uuid, code text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  s pickleball.sessions;
begin
  if (select auth.uid()) is null or not core.is_active() then perform pickleball.refuse('Sign in first.'); end if;
  select * into s from pickleball.sessions x where x.id = session;
  if not found or s.ended_at is not null or s.helper_hash is null or s.helper_hash <> core.hash_code(code) then
    perform pickleball.refuse('That helper code doesn''t work. Ask for a new one.');
  end if;
  insert into pickleball.session_helpers (session_id, user_id) values (session, (select auth.uid())) on conflict do nothing;
  if found then perform pickleball.note(session, null, 'helper joined'); end if;
  return s.watch_code;
end;
$$;

-- Saves the queue (order, breaks, pairs, skips…: the page's own format) if nobody changed the session since
-- `version`; returns the new version. `action` and `detail` say what changed, for the log.
create function pickleball.save_state(session uuid, version int, state jsonb, action text, detail jsonb default null)
returns int
language plpgsql security definer set search_path = '' as $$
declare
  now_version int;
begin
  perform pickleball.require_helper(session);
  if action !~ '^[a-z][a-z ]{0,29}$' then perform pickleball.refuse('Something went wrong. Try again.'); end if;
  update pickleball.sessions s set state = save_state.state, version = s.version + 1
  where s.id = session and s.version = save_state.version returning s.version into now_version;
  if not found then perform pickleball.refuse('Someone else just changed this. Showing the latest.'); end if;
  perform pickleball.note(session, null, action, detail);
  return now_version;
end;
$$;

-- Puts a match on a court: each side one or two players who are here and not on a court. Returns its id.
create function pickleball.start_match(session uuid, court int, side_a uuid[], side_b uuid[]) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  everyone uuid[] := coalesce(side_a, '{}') || coalesce(side_b, '{}');
  id bigint;
begin
  perform pickleball.require_helper(session);
  if cardinality(coalesce(side_a, '{}')) not between 1 and 2 or cardinality(coalesce(side_b, '{}')) not between 1 and 2
      or (select count(distinct p) from unnest(everyone) p) <> cardinality(everyone) then
    perform pickleball.refuse('Each side is one or two different players.');
  end if;
  if court < 1 or court > (select s.courts from pickleball.sessions s where s.id = session) then
    perform pickleball.refuse('There''s no such court.');
  end if;
  if exists (select 1 from unnest(everyone) p where not exists (
      select 1 from pickleball.session_players x where x.session_id = session and x.player_id = p and x.here)) then
    perform pickleball.refuse('Everyone playing has to be here.');
  end if;
  if exists (select 1 from pickleball.matches m where m.session_id = session and m.ended_at is null
      and (m.court = start_match.court or m.side_a && everyone or m.side_b && everyone)) then
    perform pickleball.refuse('That court or someone in this match is already playing.');
  end if;
  insert into pickleball.matches (session_id, court, side_a, side_b) values (session, court, side_a, side_b)
  returning matches.id into id;
  perform pickleball.bump(session);
  perform pickleball.note(session, null, 'started match', jsonb_build_object('match', id, 'court', court));
  return id;
end;
$$;

-- Ends a match (or, already ended, just changes its score). Scores are optional: null, null.
create function pickleball.end_match(match_id bigint, score_a int default null, score_b int default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  session uuid := (select m.session_id from pickleball.matches m where m.id = match_id);
begin
  if session is null then perform pickleball.refuse('There''s no such match.'); end if;
  perform pickleball.require_helper(session);
  if (score_a is null) <> (score_b is null) then perform pickleball.refuse('Give both scores, or neither.'); end if;
  update pickleball.matches m set ended_at = coalesce(m.ended_at, now()), score_a = end_match.score_a, score_b = end_match.score_b
  where m.id = match_id;
  perform pickleball.bump(session);
  perform pickleball.note(session, null, 'ended match', jsonb_build_object('match', match_id, 'score', jsonb_build_array(score_a, score_b)));
end;
$$;

-- ---------- the live view (anyone with the link) ----------

-- The session for its watch code: courts, queue state, who's here and the matches (the open ones and the last 20),
-- with names and icons. Nothing else: no managers, no log, no codes. null for a code that doesn't work.
create function pickleball.watch(code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', s.id, 'club', c.name, 'courts', s.courts, 'algorithm', s.algorithm, 'state', s.state, 'version', s.version,
    'started_at', s.started_at, 'ended_at', s.ended_at,
    'players', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'icon', p.icon, 'here', sp.here)
      order by p.name) from pickleball.session_players sp join pickleball.players p on p.id = sp.player_id
      where sp.session_id = s.id), '[]'),
    'matches', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'court', m.court, 'side_a', m.side_a,
      'side_b', m.side_b, 'started_at', m.started_at, 'ended_at', m.ended_at, 'score_a', m.score_a, 'score_b', m.score_b)
      order by m.id) from (select * from pickleball.matches x where x.session_id = s.id
        and (x.ended_at is null or x.id in (select y.id from pickleball.matches y where y.session_id = s.id
          and y.ended_at is not null order by y.id desc limit 20))) m), '[]'))
  from pickleball.sessions s left join pickleball.clubs c on c.id = s.club_id
  where s.watch_code = core.clean_code(code);
$$;

-- ---------- reading (managers) ----------

grant select on pickleball.players, pickleball.clubs, pickleball.club_managers, pickleball.club_players,
  pickleball.session_players, pickleball.matches, pickleball.log to authenticated;
grant select (id, club_id, courts, algorithm, state, version, watch_code, started_by, started_at, ended_at)
  on pickleball.sessions to authenticated;
create policy "managers read players" on pickleball.players for select to authenticated using ((select pickleball.is_manager()));
create policy "managers read clubs" on pickleball.clubs for select to authenticated using ((select pickleball.is_manager()));
create policy "managers read club managers" on pickleball.club_managers for select to authenticated using ((select pickleball.is_manager()));
create policy "managers read club players" on pickleball.club_players for select to authenticated using ((select pickleball.is_manager()));
create policy "managers read sessions" on pickleball.sessions for select to authenticated using ((select pickleball.is_manager()));
create policy "managers read who's here" on pickleball.session_players for select to authenticated using ((select pickleball.is_manager()));
create policy "managers read matches" on pickleball.matches for select to authenticated using ((select pickleball.is_manager()));
create policy "runners read their sessions' log" on pickleball.log for select to authenticated
  using (session_id is not null and pickleball.runs(session_id));
-- (session_helpers: nobody reads it through the API.)

revoke execute on all functions in schema pickleball from public;
alter default privileges in schema pickleball revoke execute on functions from public;
grant execute on function pickleball.is_manager(), pickleball.runs(uuid), pickleball.make_player(text, text), pickleball.edit_player(uuid, text, text),
  pickleball.make_club(text), pickleball.rename_club(uuid, text), pickleball.add_club_player(uuid, uuid),
  pickleball.remove_club_player(uuid, uuid), pickleball.add_club_manager(uuid, uuid), pickleball.remove_club_manager(uuid, uuid),
  pickleball.start_session(uuid, int, text, uuid[]), pickleball.set_session(uuid, int, text), pickleball.set_here(uuid, uuid, boolean),
  pickleball.helper_code(uuid), pickleball.end_session(uuid), pickleball.become_helper(uuid, text),
  pickleball.save_state(uuid, int, jsonb, text, jsonb), pickleball.start_match(uuid, int, uuid[], uuid[]),
  pickleball.end_match(bigint, int, int), pickleball.watch(text) to authenticated;
grant execute on function pickleball.watch(text) to anon;
