-- Pickleball: session names, and guests who stay in their session.
--   A session may have a name ("Saturday doubles"; null: the club's name shows): given at the start, changed by its
--   runners (rename_session). watch() and my_games() return it.
--   A guest (players.guest) is a player made for one session: they don't show in managers' player lists or club
--   pickers. keep_player makes a guest a regular player (as does adding them to a club); a guest can be linked to an
--   account like anyone.
-- (start_session and make_player gain an optional last argument: the old calls, by name, still work.)

alter table pickleball.sessions add column name text check (name = btrim(name) and char_length(name) between 1 and 40
  and name !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]');
grant select (name) on pickleball.sessions to authenticated;
alter table pickleball.players add column guest boolean not null default false;

drop function pickleball.make_player(text, text);
create function pickleball.make_player(name text, icon text default null, guest boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  id uuid;
begin
  perform pickleball.require_manager();
  insert into pickleball.players (name, icon, made_by, guest)
  values (name, coalesce(nullif(btrim(icon), ''), '👤'), (select auth.uid()), coalesce(guest, false))
  returning players.id into id;
  perform pickleball.note(null, null, case when guest then 'made guest' else 'made player' end, jsonb_build_object('player', id, 'name', name));
  return id;
end;
$$;

-- A guest becomes a regular player: whoever may edit them (their maker, or a manager of a club they're in).
create function pickleball.keep_player(player uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not pickleball.may_edit_player(player) then
    perform pickleball.refuse('Only whoever added this player, or a manager of their club, can do that.');
  end if;
  update pickleball.players p set guest = false where p.id = player and p.guest;
  if found then perform pickleball.note(null, null, 'kept guest', jsonb_build_object('player', player)); end if;
end;
$$;

-- Adding a guest to a club keeps them too.
create or replace function pickleball.add_club_player(club uuid, player uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pickleball.require_club(club);
  if not exists (select 1 from pickleball.players p where p.id = player) then perform pickleball.refuse('There''s no such player.'); end if;
  insert into pickleball.club_players (club_id, player_id, added_by) values (club, player, (select auth.uid())) on conflict do nothing;
  update pickleball.players p set guest = false where p.id = player and p.guest;
  perform pickleball.note(null, club, 'added player', jsonb_build_object('player', player));
end;
$$;

drop function pickleball.start_session(uuid, int, text, uuid[]);
create function pickleball.start_session(club uuid, courts int, algorithm text, players uuid[], name text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  id uuid;
begin
  perform pickleball.require_manager();
  if club is not null then perform pickleball.require_club(club); end if;
  if exists (select 1 from unnest(coalesce(players, '{}')) p where not exists (select 1 from pickleball.players x where x.id = p)) then
    perform pickleball.refuse('There''s no such player.');
  end if;
  insert into pickleball.sessions (club_id, courts, algorithm, watch_code, started_by, name)
  values (club, courts, algorithm, core.new_code(), (select auth.uid()), nullif(btrim(name), '')) returning sessions.id into id;
  insert into pickleball.session_players (session_id, player_id) select distinct id, p from unnest(coalesce(players, '{}')) p;
  perform pickleball.note(id, club, 'started session', jsonb_build_object('courts', courts, 'algorithm', algorithm, 'name', name));
  return id;
end;
$$;

create function pickleball.rename_session(session uuid, name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pickleball.require_runner(session);
  update pickleball.sessions s set name = nullif(btrim(rename_session.name), ''), version = s.version + 1 where s.id = session;
  perform pickleball.note(session, null, 'renamed session', jsonb_build_object('name', name));
end;
$$;

create or replace function pickleball.watch(code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', s.id, 'name', s.name, 'club', c.name, 'courts', s.courts, 'algorithm', s.algorithm, 'state', s.state, 'version', s.version,
    'started_at', s.started_at, 'ended_at', s.ended_at,
    'players', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'icon', p.icon, 'here', sp.here, 'guest', p.guest)
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

create or replace function pickleball.my_games() returns jsonb
language sql stable security definer set search_path = '' as $$
  with mine as (select l.player_id from pickleball.player_links l where l.user_id = (select auth.uid())),
  played as (
    select mi.player_id, m.*, (mi.player_id = any (m.side_a)) as on_a
    from mine mi join pickleball.matches m on mi.player_id = any (m.side_a) or mi.player_id = any (m.side_b)
    where m.ended_at is not null)
  select jsonb_build_object(
    'players', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'icon', p.icon,
      'sessions', (select count(*) from pickleball.session_players sp where sp.player_id = p.id),
      'matches', (select count(*) from played x where x.player_id = p.id),
      'wins', (select count(*) from played x where x.player_id = p.id and x.score_a is not null and x.score_a <> x.score_b
        and (x.score_a > x.score_b) = x.on_a),
      'minutes', (select coalesce(round(sum(extract(epoch from x.ended_at - x.started_at)) / 60), 0) from played x where x.player_id = p.id))
      order by p.name) from pickleball.players p where p.id in (select player_id from mine)), '[]'),
    'sessions', coalesce((select jsonb_agg(s order by s.started_at desc) from (
      select s.id, s.name, c.name as club, s.started_at, s.ended_at, s.watch_code,
        (select count(*) from pickleball.matches m where m.session_id = s.id and m.ended_at is not null
          and exists (select 1 from mine mi where mi.player_id = any (m.side_a) or mi.player_id = any (m.side_b))) as matches
      from pickleball.sessions s left join pickleball.clubs c on c.id = s.club_id
      where exists (select 1 from pickleball.session_players sp join mine mi on mi.player_id = sp.player_id where sp.session_id = s.id)
      order by s.started_at desc limit 30) s), '[]'));
$$;

revoke execute on all functions in schema pickleball from public;
grant execute on function pickleball.is_manager(), pickleball.runs(uuid), pickleball.make_player(text, text, boolean), pickleball.edit_player(uuid, text, text),
  pickleball.make_club(text), pickleball.rename_club(uuid, text), pickleball.add_club_player(uuid, uuid),
  pickleball.remove_club_player(uuid, uuid), pickleball.add_club_manager(uuid, uuid), pickleball.remove_club_manager(uuid, uuid),
  pickleball.start_session(uuid, int, text, uuid[], text), pickleball.set_session(uuid, int, text), pickleball.set_here(uuid, uuid, boolean),
  pickleball.helper_code(uuid), pickleball.end_session(uuid), pickleball.become_helper(uuid, text),
  pickleball.save_state(uuid, int, jsonb, text, jsonb), pickleball.start_match(uuid, int, uuid[], uuid[]),
  pickleball.end_match(bigint, int, int), pickleball.watch(text), pickleball.managers(),
  pickleball.link_code(uuid), pickleball.link_player(text), pickleball.unlink_player(uuid), pickleball.links(), pickleball.my_games(),
  pickleball.rename_session(uuid, text), pickleball.keep_player(uuid)
  to authenticated;
grant execute on function pickleball.watch(text) to anon;
