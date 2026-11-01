-- Pickleball: linking an account to players. A player stays a manager's record (a name and an icon, no account
-- needed); a person with an account can link it to the players that are them, in any number of clubs, with a
-- one-time code from a manager (a QR). Linked, they see their sessions, matches and numbers (my_games).
--   link_code(player)     a manager who may edit the player (its maker, or a manager of a club it's in) makes a code,
--                         valid 7 days; a new one replaces the old
--   link_player(code)     an account (not an anonymous sign-in) links itself; a player links to one account at most
--   unlink_player(player) the linked account, or a manager who may edit the player
--   links()               managers: who each linked player is linked to (username, name, avatar)
--   my_games()            your linked players, with their numbers, and the sessions they played in

create table pickleball.player_links (
  player_id uuid primary key references pickleball.players (id),
  user_id uuid not null references core.accounts (id),
  linked_at timestamptz not null default now()
);
create index on pickleball.player_links (user_id);

create table pickleball.link_codes (
  player_id uuid primary key references pickleball.players (id),
  code_hash text not null unique,
  made_by uuid not null references core.accounts (id),
  expires_at timestamptz not null default now() + interval '7 days'
);

alter table pickleball.player_links enable row level security;
alter table pickleball.link_codes enable row level security;
-- (Neither is readable through the API: links() and my_games() say what each person may know.)

create function pickleball.may_edit_player(player uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select pickleball.is_manager() and exists (select 1 from pickleball.players p where p.id = player and (p.made_by = (select auth.uid())
    or exists (select 1 from pickleball.club_players c where c.player_id = p.id and pickleball.manages_club(c.club_id))));
$$;

create function pickleball.link_code(player uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  code text := core.new_code();
begin
  if not pickleball.may_edit_player(player) then
    perform pickleball.refuse('Only whoever added this player, or a manager of their club, can do that.');
  end if;
  if exists (select 1 from pickleball.player_links l where l.player_id = player) then
    perform pickleball.refuse('This player is already linked to an account.');
  end if;
  insert into pickleball.link_codes (player_id, code_hash, made_by) values (player, core.hash_code(code), (select auth.uid()))
  on conflict (player_id) do update set code_hash = excluded.code_hash, made_by = excluded.made_by, expires_at = excluded.expires_at;
  perform pickleball.note(null, null, 'made link code', jsonb_build_object('player', player));
  return code;
end;
$$;

-- Returns the linked player: { id, name, icon }.
create function pickleball.link_player(code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  found_player uuid;
begin
  if not exists (select 1 from core.accounts a where a.id = me and a.active) then
    perform pickleball.refuse('Sign in to your account first.');
  end if;
  select c.player_id into found_player from pickleball.link_codes c where c.code_hash = core.hash_code(code) and c.expires_at > now();
  if found_player is null then perform pickleball.refuse('That code doesn''t work. Ask for a new one.'); end if;
  delete from pickleball.link_codes c where c.player_id = found_player;
  insert into pickleball.player_links (player_id, user_id) values (found_player, me);
  perform pickleball.note(null, null, 'linked player', jsonb_build_object('player', found_player));
  return (select jsonb_build_object('id', p.id, 'name', p.name, 'icon', p.icon) from pickleball.players p where p.id = found_player);
end;
$$;

create function pickleball.unlink_player(player uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from pickleball.player_links l where l.player_id = player and l.user_id = (select auth.uid()))
      and not pickleball.may_edit_player(player) then
    perform pickleball.refuse('Only the linked account, or a manager of this player, can unlink it.');
  end if;
  delete from pickleball.player_links l where l.player_id = player;
  if found then perform pickleball.note(null, null, 'unlinked player', jsonb_build_object('player', player)); end if;
end;
$$;

create function pickleball.links()
returns table (player_id uuid, username text, display_name text, avatar text)
language sql stable security definer set search_path = '' as $$
  select l.player_id, a.username, p.display_name, p.avatar
  from pickleball.player_links l join core.accounts a on a.id = l.user_id left join core.profiles p on p.id = l.user_id
  where pickleball.is_manager();
$$;

-- { players: [{ id, name, icon, sessions, matches, wins, minutes }],
--   sessions: [{ id, club, started_at, ended_at, watch_code, matches }] (the last 30, newest first) }
create function pickleball.my_games() returns jsonb
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
      select s.id, c.name as club, s.started_at, s.ended_at, s.watch_code,
        (select count(*) from pickleball.matches m where m.session_id = s.id and m.ended_at is not null
          and exists (select 1 from mine mi where mi.player_id = any (m.side_a) or mi.player_id = any (m.side_b))) as matches
      from pickleball.sessions s left join pickleball.clubs c on c.id = s.club_id
      where exists (select 1 from pickleball.session_players sp join mine mi on mi.player_id = sp.player_id where sp.session_id = s.id)
      order by s.started_at desc limit 30) s), '[]'));
$$;

revoke execute on all functions in schema pickleball from public;
grant execute on function pickleball.is_manager(), pickleball.runs(uuid), pickleball.make_player(text, text), pickleball.edit_player(uuid, text, text),
  pickleball.make_club(text), pickleball.rename_club(uuid, text), pickleball.add_club_player(uuid, uuid),
  pickleball.remove_club_player(uuid, uuid), pickleball.add_club_manager(uuid, uuid), pickleball.remove_club_manager(uuid, uuid),
  pickleball.start_session(uuid, int, text, uuid[]), pickleball.set_session(uuid, int, text), pickleball.set_here(uuid, uuid, boolean),
  pickleball.helper_code(uuid), pickleball.end_session(uuid), pickleball.become_helper(uuid, text),
  pickleball.save_state(uuid, int, jsonb, text, jsonb), pickleball.start_match(uuid, int, uuid[], uuid[]),
  pickleball.end_match(bigint, int, int), pickleball.watch(text), pickleball.managers(),
  pickleball.link_code(uuid), pickleball.link_player(text), pickleball.unlink_player(uuid), pickleball.links(), pickleball.my_games()
  to authenticated;
grant execute on function pickleball.watch(text) to anon;
