-- Roles are only admin (of an app) and superuser now: an account with no role is a plain user already, so the "user"
-- role meant nothing. (None were given; any pending invite offering it becomes a plain invite.)

update core.invites set role = null, scope = '*' where role = 'user';
delete from core.roles where role = 'user';

alter table core.roles drop constraint roles_role_check;
alter table core.roles add constraint roles_role_check check (role in ('superuser', 'admin'));
alter table core.invites drop constraint invites_role_check;
alter table core.invites add constraint invites_role_check check (role in ('superuser', 'admin'));

-- admin < superuser.
create or replace function core.has_role(min_role text, app text default '*') returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core.roles r join core.accounts a on a.id = r.user_id
    where r.user_id = (select auth.uid()) and a.active and (r.scope = '*' or r.scope = app)
      and array_position(array['admin', 'superuser'], r.role) >= array_position(array['admin', 'superuser'], min_role));
$$;
