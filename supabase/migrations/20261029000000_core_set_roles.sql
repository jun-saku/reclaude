-- Roles in two kinds, managed from the admin panel:
--   core roles (core.roles): superuser or admin, for the whole site. Only superusers give or take them.
--   project roles (core.app_roles): each project (app) lists its own roles in core.apps / core.app_role_names
--     from its own migration (e.g. pickleball: organiser, scorekeeper); a person can hold several. Core admins and
--     superusers give and take them. A project's policies check them with core.has_app_role(app, role).
-- Nobody changes their own roles (so there's always a superuser), and each change is in core.audit.

-- Core roles are for every project now: a role "for one app" becomes a project role. (None were given: any such
-- row, and any pending invite offering one, goes.)
delete from core.roles where scope <> '*';
alter table core.roles add constraint roles_core_only check (scope = '*');
update core.invites set role = null, scope = '*' where scope <> '*' and used_at is null;
alter table core.invites add constraint invites_core_only check (scope = '*' or used_at is not null);

-- ---------- projects and their roles ----------

create table core.apps (
  name text primary key check (name ~ '^[a-z][a-z0-9_]{0,30}$'), -- its schema name
  title text not null check (char_length(title) between 1 and 40)
);
create table core.app_role_names (
  app text not null references core.apps (name) on delete cascade,
  role text not null check (role ~ '^[a-z][a-z0-9_]{0,30}$'),
  title text not null check (char_length(title) between 1 and 40),
  primary key (app, role)
);
create table core.app_roles (
  user_id uuid not null references core.accounts (id),
  app text not null,
  role text not null,
  granted_by uuid references core.accounts (id),
  granted_at timestamptz not null default now(),
  primary key (user_id, app, role),
  foreign key (app, role) references core.app_role_names (app, role) on delete cascade
);
alter table core.apps enable row level security;
alter table core.app_role_names enable row level security;
alter table core.app_roles enable row level security;

-- true if the signed-in user is an active account holding this project role, or a superuser.
create function core.has_app_role(app text, role text) returns boolean
language sql stable security definer set search_path = '' as $$
  select core.is_superuser() or exists (
    select 1 from core.app_roles r join core.accounts a on a.id = r.user_id
    where r.user_id = (select auth.uid()) and a.active and r.app = has_app_role.app and r.role = has_app_role.role);
$$;

create function core.require_admin() returns void
language plpgsql stable set search_path = '' as $$
begin
  if not core.is_admin() then
    raise exception 'Only an admin can do that.' using errcode = '42501';
  end if;
end;
$$;

create function core.not_yourself(target uuid) returns void
language plpgsql stable set search_path = '' as $$
begin
  if target = (select auth.uid()) then
    raise exception 'You can''t change your own roles.' using errcode = '42501';
  end if;
  if not exists (select 1 from core.accounts where id = target) then
    raise exception 'There''s no such account.' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------- core roles (superusers) ----------

-- Gives `target` the core role `role` (admin or superuser), replacing the one they had.
create function core.set_role(target uuid, role text) returns void
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  before text;
begin
  perform core.require_superuser();
  perform core.not_yourself(target);
  select r.role into before from core.roles r where r.user_id = target;
  insert into core.roles (user_id, role, scope, granted_by) values (target, set_role.role, '*', (select auth.uid()))
  on conflict (user_id, scope) do update set role = excluded.role, granted_by = excluded.granted_by, granted_at = now();
  if before is distinct from set_role.role then
    insert into core.audit (actor, action, target, detail)
    values ((select auth.uid()), 'gave role', target, jsonb_build_object('app', 'core', 'role', set_role.role, 'was', before));
  end if;
end;
$$;

-- Takes away `target`'s core role.
create function core.remove_role(target uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  gone text;
begin
  perform core.require_superuser();
  perform core.not_yourself(target);
  delete from core.roles r where r.user_id = target returning r.role into gone;
  if gone is not null then
    insert into core.audit (actor, action, target, detail)
    values ((select auth.uid()), 'removed role', target, jsonb_build_object('app', 'core', 'role', gone));
  end if;
end;
$$;

-- ---------- project roles (admins and superusers) ----------

create function core.give_app_role(target uuid, app text, role text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform core.require_admin();
  perform core.not_yourself(target);
  if not exists (select 1 from core.app_role_names n where n.app = give_app_role.app and n.role = give_app_role.role) then
    raise exception 'That project has no such role.' using errcode = 'P0002';
  end if;
  insert into core.app_roles (user_id, app, role, granted_by) values (target, app, role, (select auth.uid()))
  on conflict do nothing;
  if found then
    insert into core.audit (actor, action, target, detail)
    values ((select auth.uid()), 'gave role', target, jsonb_build_object('app', app, 'role', role));
  end if;
end;
$$;

create function core.remove_app_role(target uuid, app text, role text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform core.require_admin();
  perform core.not_yourself(target);
  delete from core.app_roles r where r.user_id = target and r.app = remove_app_role.app and r.role = remove_app_role.role;
  if found then
    insert into core.audit (actor, action, target, detail)
    values ((select auth.uid()), 'removed role', target, jsonb_build_object('app', app, 'role', role));
  end if;
end;
$$;

-- ---------- who sees what ----------

grant select on core.apps, core.app_role_names, core.app_roles to authenticated;
create policy "projects are readable by signed-in users" on core.apps for select to authenticated using (true);
create policy "project roles are readable by signed-in users" on core.app_role_names for select to authenticated using (true);
create policy "users see their own project roles; admins see all" on core.app_roles
  for select to authenticated using (user_id = (select auth.uid()) or (select core.is_admin()));
-- Admins see every account (to give project roles); changing them stays with superusers.
drop policy "users see their own account; superusers see all" on core.accounts;
create policy "users see their own account; admins see all" on core.accounts
  for select to authenticated using (id = (select auth.uid()) or (select core.is_admin()));
drop policy "users see their own roles; superusers see all" on core.roles;
create policy "users see their own roles; admins see all" on core.roles
  for select to authenticated using (user_id = (select auth.uid()) or (select core.is_admin()));

revoke execute on all functions in schema core from public;
grant execute on function core.is_active(), core.has_role(text, text), core.is_superuser(), core.is_admin(),
  core.has_app_role(text, text), core.make_account(text, text, text), core.change_key(text),
  core.make_invite(text, text, int, text), core.cancel_invite(bigint), core.set_active(uuid, boolean),
  core.reset_key(uuid), core.edit_account(uuid, text, text, text), core.set_role(uuid, text), core.remove_role(uuid),
  core.give_app_role(uuid, text, text), core.remove_app_role(uuid, text, text) to authenticated;
