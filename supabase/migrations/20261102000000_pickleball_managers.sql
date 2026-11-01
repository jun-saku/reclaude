-- Pickleball: the managers, by name, for managers to pick from (adding a club manager) and to show who manages a club.
-- (Managers can't read core.accounts or core.app_roles of others; this gives them just this list.)

-- Active accounts that can manage (the pickleball manager role, or superusers): id, username, name and avatar.
-- Empty for anyone who isn't a manager.
create function pickleball.managers()
returns table (id uuid, username text, display_name text, avatar text)
language sql stable security definer set search_path = '' as $$
  select a.id, a.username, p.display_name, p.avatar
  from core.accounts a left join core.profiles p on p.id = a.id
  where pickleball.is_manager() and a.active and (
    exists (select 1 from core.app_roles r where r.user_id = a.id and r.app = 'pickleball' and r.role = 'manager')
    or exists (select 1 from core.roles r where r.user_id = a.id and r.role = 'superuser'))
  order by a.username;
$$;

revoke execute on all functions in schema pickleball from public;
grant execute on function pickleball.is_manager(), pickleball.runs(uuid), pickleball.make_player(text, text), pickleball.edit_player(uuid, text, text),
  pickleball.make_club(text), pickleball.rename_club(uuid, text), pickleball.add_club_player(uuid, uuid),
  pickleball.remove_club_player(uuid, uuid), pickleball.add_club_manager(uuid, uuid), pickleball.remove_club_manager(uuid, uuid),
  pickleball.start_session(uuid, int, text, uuid[]), pickleball.set_session(uuid, int, text), pickleball.set_here(uuid, uuid, boolean),
  pickleball.helper_code(uuid), pickleball.end_session(uuid), pickleball.become_helper(uuid, text),
  pickleball.save_state(uuid, int, jsonb, text, jsonb), pickleball.start_match(uuid, int, uuid[], uuid[]),
  pickleball.end_match(bigint, int, int), pickleball.watch(text), pickleball.managers() to authenticated;
grant execute on function pickleball.watch(text) to anon;
