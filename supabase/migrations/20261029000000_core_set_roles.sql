-- Roles from the admin panel: a superuser gives an account a role (admin of one app or every app, or superuser) or
-- takes one away. Not their own roles, so there's always a superuser. Each change is in core.audit.

-- Gives `target` the role `role` for `scope` (an app, or '*' for every app), replacing any role it had there.
create function core.set_role(target uuid, role text, scope text default '*') returns void
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  before text;
begin
  perform core.require_superuser();
  if target = (select auth.uid()) then
    raise exception 'You can''t change your own roles.' using errcode = '42501';
  end if;
  if not exists (select 1 from core.accounts where id = target) then
    raise exception 'There''s no such account.' using errcode = 'P0002';
  end if;
  set_role.scope := coalesce(nullif(btrim(set_role.scope), ''), '*');
  if set_role.role = 'superuser' and set_role.scope <> '*' then
    raise exception 'A superuser is for every app.' using errcode = '22023';
  end if;
  select r.role into before from core.roles r where r.user_id = target and r.scope = set_role.scope;
  insert into core.roles as r (user_id, role, scope, granted_by) values (target, set_role.role, set_role.scope, (select auth.uid()))
  on conflict (user_id, scope) do update set role = excluded.role, granted_by = excluded.granted_by, granted_at = now();
  if before is distinct from set_role.role then
    insert into core.audit (actor, action, target, detail)
    values ((select auth.uid()), 'gave role', target, jsonb_build_object('role', set_role.role, 'scope', set_role.scope, 'was', before));
  end if;
end;
$$;

-- Takes away `target`'s role for `scope`.
create function core.remove_role(target uuid, scope text default '*') returns void
language plpgsql security definer set search_path = '' as $$
declare
  gone text;
begin
  perform core.require_superuser();
  if target = (select auth.uid()) then
    raise exception 'You can''t change your own roles.' using errcode = '42501';
  end if;
  delete from core.roles r where r.user_id = target and r.scope = coalesce(nullif(btrim(remove_role.scope), ''), '*')
  returning r.role into gone;
  if gone is not null then
    insert into core.audit (actor, action, target, detail)
    values ((select auth.uid()), 'removed role', target, jsonb_build_object('role', gone, 'scope', coalesce(nullif(btrim(scope), ''), '*')));
  end if;
end;
$$;

revoke execute on all functions in schema core from public;
grant execute on function core.is_active(), core.has_role(text, text), core.is_superuser(), core.is_admin(),
  core.make_account(text, text, text), core.change_key(text), core.make_invite(text, text, int, text),
  core.cancel_invite(bigint), core.set_active(uuid, boolean), core.reset_key(uuid),
  core.edit_account(uuid, text, text, text), core.set_role(uuid, text, text), core.remove_role(uuid, text) to authenticated;
