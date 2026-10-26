-- Invites, one code per person, made in the admin panel: a pending invite's code stays readable (to whoever made it,
-- and superusers) so it can be copied again, until it's used or cancelled; each can carry a note ("for Ana"). Admins
-- (of any app) can make plain invites too; only superusers make invites that give a role. Accounts stay invite-only.
-- (Invites made before this have no readable code: only their hash.)

alter table core.invites add column code text;
alter table core.invites add column note text
  check (note = btrim(note) and char_length(note) between 1 and 60 and note !~ '[<>&[:cntrl:]]');

-- true for an active admin or superuser of any app.
create function core.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core.roles r join core.accounts a on a.id = r.user_id
    where r.user_id = (select auth.uid()) and a.active and r.role in ('admin', 'superuser'));
$$;

drop function core.make_invite(text, text, int);

-- A new invite code for one person: optionally with a note, and (superusers only) a role for the new account.
-- Lasts `days` days (1 to 30).
create function core.make_invite(role text default null, scope text default '*', days int default 7, note text default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  code text := core.new_code();
  invite_id bigint;
begin
  if not core.is_admin() then
    raise exception 'Only an admin can make invites.' using errcode = '42501';
  end if;
  if role is not null and not core.is_superuser() then
    raise exception 'Only a superuser can make invites that give a role.' using errcode = '42501';
  end if;
  if days is null or days not between 1 and 30 then
    raise exception 'An invite lasts 1 to 30 days.' using errcode = '22023';
  end if;
  insert into core.invites (code_hash, code, note, role, scope, made_by, expires_at)
  values (core.hash_code(code), code, nullif(btrim(note), ''), role, coalesce(scope, '*'), (select auth.uid()),
    now() + make_interval(days => days))
  returning id into invite_id;
  insert into core.audit (actor, action, detail)
  values ((select auth.uid()), 'made invite',
    jsonb_build_object('invite', invite_id, 'role', role, 'scope', scope, 'days', days, 'note', nullif(btrim(note), '')));
  return code;
end;
$$;

-- Cancels a pending invite: your own, or anyone's for a superuser.
create or replace function core.cancel_invite(invite_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (core.is_superuser()
      or (core.is_admin() and exists (select 1 from core.invites where id = invite_id and made_by = (select auth.uid())))) then
    raise exception 'You can cancel only your own invites.' using errcode = '42501';
  end if;
  update core.invites set expires_at = now(), code = null where id = invite_id and used_at is null and expires_at > now();
  if found then
    insert into core.audit (actor, action, detail)
    values ((select auth.uid()), 'cancelled invite', jsonb_build_object('invite', invite_id));
  end if;
end;
$$;

-- Using an invite clears its code. (make_account sets used_at; the code goes with it.)
create function core.forget_used_code() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.used_at is not null then new.code := null; end if;
  return new;
end;
$$;

create trigger invites_forget_used_code before update of used_at on core.invites
  for each row execute function core.forget_used_code();

-- The first superuser's invite (by hand in the SQL editor) is readable there too.
create or replace function core.first_invite() returns text
language plpgsql security definer set search_path = '' as $$
declare
  code text := core.new_code();
begin
  if exists (select 1 from core.roles where role = 'superuser') then
    raise exception 'There''s already a superuser: they make the invites.' using errcode = '42501';
  end if;
  insert into core.invites (code_hash, code, note, role, scope, expires_at)
  values (core.hash_code(code), code, 'first superuser', 'superuser', '*', now() + interval '1 day');
  return code;
end;
$$;

-- Admins see the invites they made; superusers see all.
drop policy "superusers see invites" on core.invites;
create policy "admins see their invites; superusers see all" on core.invites
  for select to authenticated using (made_by = (select auth.uid()) and (select core.is_admin()) or (select core.is_superuser()));

revoke execute on all functions in schema core from public;
grant execute on function core.is_active(), core.has_role(text, text), core.is_superuser(), core.is_admin(),
  core.make_account(text, text, text), core.change_key(text), core.make_invite(text, text, int, text),
  core.cancel_invite(bigint), core.set_active(uuid, boolean), core.reset_key(uuid),
  core.edit_account(uuid, text, text, text) to authenticated;
