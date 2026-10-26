-- Accounts: an anonymous user can become an account (a username and a personal key) to use their profile on other
-- devices. No email, name or other personal data: the sign-in is Supabase's email + password, with a made-up address
-- (<username>@users.reclaude.invalid, which can never receive mail) and the key as the password (only its hash is
-- stored). Accounts need an invite from a superuser, are never deleted (a superuser deactivates them: their data
-- stays) and can hold roles. Every change a superuser makes is written to core.audit.
--
-- Keys and invite codes are 16 characters of Crockford base32 (0-9 and A-Z without I L O U: 80 random bits), shown
-- in groups of four (7KQM-2XRP-H9TD-4WVN). core.clean_code() reads them back the way people type them. Pages send
-- keys only cleaned (shared/core.js), since Supabase's sign-in compares the password exactly.
--
-- The first superuser: after this migration is live, run `select core.first_invite();` in the dashboard's SQL editor
-- and make the account with the code it returns. It works only while there's no superuser and nobody else can call it.

create table core.accounts (
  -- No cascade: deleting the sign-in of an account is refused, so its data can't go by accident.
  id uuid primary key references auth.users (id),
  username text not null unique check (username ~ '^[a-z0-9][a-z0-9_]{2,19}$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Roles, by app: scope is an app's schema name, or '*' for every app. A superuser can do everything everywhere.
create table core.roles (
  user_id uuid not null references core.accounts (id),
  role text not null check (role in ('superuser', 'admin', 'user')),
  scope text not null default '*' check (scope = '*' or scope ~ '^[a-z][a-z0-9_]{0,30}$'),
  granted_by uuid references core.accounts (id),
  granted_at timestamptz not null default now(),
  primary key (user_id, scope),
  check (role <> 'superuser' or scope = '*')
);

-- Invites: only the code's hash is kept; the code is shown once, to the superuser who made it.
create table core.invites (
  id bigint generated always as identity primary key,
  code_hash text not null unique,
  role text check (role in ('superuser', 'admin', 'user')),
  scope text not null default '*' check (scope = '*' or scope ~ '^[a-z][a-z0-9_]{0,30}$'),
  made_by uuid references core.accounts (id), -- null: core.first_invite()
  made_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_by uuid references core.accounts (id),
  used_at timestamptz,
  check (role is distinct from 'superuser' or scope = '*')
);

-- What happened to accounts, by whom: written only by the functions below.
create table core.audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid references core.accounts (id),
  action text not null,
  target uuid references core.accounts (id),
  detail jsonb not null default '{}'
);

alter table core.accounts enable row level security;
alter table core.roles enable row level security;
alter table core.invites enable row level security;
alter table core.audit enable row level security;

create trigger accounts_updated_at before update on core.accounts
  for each row execute function core.touch_updated_at();

-- ---------- helpers ----------

-- false only for a deactivated account (anonymous users have no account: they're active).
create function core.is_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from core.accounts where id = (select auth.uid()) and not active);
$$;

-- true if the signed-in user is an active account with this role or a higher one (user < admin < superuser),
-- for this app or every app.
create function core.has_role(min_role text, app text default '*') returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core.roles r join core.accounts a on a.id = r.user_id
    where r.user_id = (select auth.uid()) and a.active and (r.scope = '*' or r.scope = app)
      and array_position(array['user', 'admin', 'superuser'], r.role)
        >= array_position(array['user', 'admin', 'superuser'], min_role));
$$;

create function core.is_superuser() returns boolean
language sql stable security definer set search_path = '' as $$
  select core.has_role('superuser');
$$;

-- A key or invite code as people type it: any case, with or without dashes and spaces, O for 0, I or L for 1.
create function core.clean_code(code text) returns text
language sql immutable set search_path = '' as $$
  select translate(regexp_replace(upper(coalesce(code, '')), '[^0-9A-Z]', '', 'g'), 'OIL', '011');
$$;

create function core.new_code() returns text
language sql volatile set search_path = '' as $$
  select string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', get_byte(b, i) % 32 + 1, 1), '' order by i)
  from extensions.gen_random_bytes(16) as b, generate_series(0, 15) as i;
$$;

create function core.hash_code(code text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(core.clean_code(code), 'sha256'), 'hex');
$$;

create function core.account_email(username text) returns text
language sql immutable set search_path = '' as $$
  select username || '@users.reclaude.invalid';
$$;

create function core.set_key(target uuid, key text) returns void
language plpgsql set search_path = '' as $$
begin
  if key !~ '^[0-9A-HJKMNP-TV-Z]{16}$' then
    raise exception 'A key is 16 letters and numbers.' using errcode = 'RCKEY';
  end if;
  update auth.users set encrypted_password = extensions.crypt(key, extensions.gen_salt('bf', 10)), updated_at = now()
  where id = target;
end;
$$;

-- Signs a user out everywhere (but this session, if given): their devices can't renew their sign-in, which lasts
-- an hour at most (and core.is_active() stops a deactivated one at once).
create function core.end_sessions(target uuid, keep uuid default null) returns void
language sql set search_path = '' as $$
  delete from auth.sessions where user_id = target and id is distinct from keep;
  delete from auth.refresh_tokens where user_id = target::text and session_id is distinct from keep;
$$;

create function core.require_superuser() returns void
language plpgsql stable set search_path = '' as $$
begin
  if not core.is_superuser() then
    raise exception 'Only a superuser can do that.' using errcode = '42501';
  end if;
end;
$$;

-- ---------- making an account ----------

-- The signed-in anonymous user becomes an account, keeping their id (and so their profile and anything else).
-- key: a new key from the page (cleaned); invite: a superuser's invite code (any form people type).
create function core.make_account(username text, key text, invite text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  inv core.invites;
begin
  if me is null or not exists (select 1 from auth.users where id = me and is_anonymous) then
    raise exception 'Only a new sign-in can become an account.' using errcode = '42501';
  end if;
  if username is null or username !~ '^[a-z0-9][a-z0-9_]{2,19}$' then
    raise exception 'A username is 3 to 20 lowercase letters, numbers or _.' using errcode = 'RCUSR';
  end if;
  if exists (select 1 from core.accounts a where a.username = make_account.username) then
    raise exception 'That username is taken.' using errcode = 'RCTKN';
  end if;
  select * into inv from core.invites
  where code_hash = core.hash_code(invite) and used_at is null and expires_at > now() for update;
  if not found then
    raise exception 'That invite code doesn''t work.' using errcode = 'RCINV';
  end if;

  perform core.set_key(me, key);
  perform set_config('core.account_write', 'on', true);
  update auth.users set
    email = core.account_email(username), email_confirmed_at = now(), is_anonymous = false,
    raw_app_meta_data = coalesce(raw_app_meta_data, '{}') || '{"provider": "email", "providers": ["email"]}',
    updated_at = now()
  where id = me;
  perform set_config('core.account_write', '', true);
  insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (me::text, me, jsonb_build_object('sub', me::text, 'email', core.account_email(username),
    'email_verified', true), 'email', now(), now(), now());
  insert into core.accounts (id, username) values (me, username);
  update core.invites set used_by = me, used_at = now() where id = inv.id;
  if inv.role is not null then
    insert into core.roles (user_id, role, scope, granted_by) values (me, inv.role, inv.scope, inv.made_by);
  end if;
  insert into core.audit (actor, action, target, detail)
  values (me, 'made account', me, jsonb_build_object('username', username, 'invite', inv.id, 'role', inv.role, 'scope', inv.scope));
end;
$$;

-- A new key for your own account; your other devices are signed out.
create function core.change_key(key text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
begin
  if not exists (select 1 from core.accounts where id = me and active) then
    raise exception 'Only an account can change its key.' using errcode = '42501';
  end if;
  perform core.set_key(me, key);
  perform core.end_sessions(me, nullif((select auth.jwt()) ->> 'session_id', '')::uuid);
  insert into core.audit (actor, action, target) values (me, 'changed key', me);
end;
$$;

-- ---------- superusers ----------

-- A new invite code (shown once): optionally with a role for the new account. Lasts `days` days (1 to 30).
create function core.make_invite(role text default null, scope text default '*', days int default 7) returns text
language plpgsql security definer set search_path = '' as $$
declare
  code text := core.new_code();
  invite_id bigint;
begin
  perform core.require_superuser();
  if days is null or days not between 1 and 30 then
    raise exception 'An invite lasts 1 to 30 days.' using errcode = '22023';
  end if;
  insert into core.invites (code_hash, role, scope, made_by, expires_at)
  values (core.hash_code(code), role, coalesce(scope, '*'), (select auth.uid()), now() + make_interval(days => days))
  returning id into invite_id;
  insert into core.audit (actor, action, detail)
  values ((select auth.uid()), 'made invite', jsonb_build_object('invite', invite_id, 'role', role, 'scope', scope, 'days', days));
  return code;
end;
$$;

create function core.cancel_invite(invite_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform core.require_superuser();
  update core.invites set expires_at = now() where id = invite_id and used_at is null and expires_at > now();
  if found then
    insert into core.audit (actor, action, detail)
    values ((select auth.uid()), 'cancelled invite', jsonb_build_object('invite', invite_id));
  end if;
end;
$$;

-- Deactivate (make_active = false) or reactivate an account. A deactivated account can't sign in, is signed out everywhere
-- and can't read or change anything; its data stays. Not your own (so there's always an active superuser).
create function core.set_active(target uuid, make_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform core.require_superuser();
  if target = (select auth.uid()) then
    raise exception 'You can''t deactivate your own account.' using errcode = '42501';
  end if;
  update core.accounts set active = make_active where id = target and active is distinct from make_active;
  if not found then return; end if;
  update auth.users set banned_until = case when make_active then null else timestamptz '2999-12-31' end, updated_at = now()
  where id = target;
  if not make_active then perform core.end_sessions(target); end if;
  insert into core.audit (actor, action, target)
  values ((select auth.uid()), case when make_active then 'reactivated' else 'deactivated' end, target);
end;
$$;

-- A new key for someone else's account (returned once, to pass on to them); they're signed out everywhere.
create function core.reset_key(target uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  key text := core.new_code();
begin
  perform core.require_superuser();
  if target = (select auth.uid()) then
    raise exception 'Change your own key from your profile.' using errcode = '42501';
  end if;
  if not exists (select 1 from core.accounts where id = target) then
    raise exception 'There''s no such account.' using errcode = 'P0002';
  end if;
  perform core.set_key(target, key);
  perform core.end_sessions(target);
  insert into core.audit (actor, action, target) values ((select auth.uid()), 'reset key', target);
  return key;
end;
$$;

-- Rename an account (its username) and edit its profile (name and avatar; null keeps them).
create function core.edit_account(target uuid, new_username text default null, new_display_name text default null,
  new_avatar text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  old core.accounts;
  before_profile jsonb;
begin
  perform core.require_superuser();
  select * into old from core.accounts where id = target for update;
  if not found then
    raise exception 'There''s no such account.' using errcode = 'P0002';
  end if;
  if new_username is not null and new_username <> old.username then
    if new_username !~ '^[a-z0-9][a-z0-9_]{2,19}$' then
      raise exception 'A username is 3 to 20 lowercase letters, numbers or _.' using errcode = 'RCUSR';
    end if;
    if exists (select 1 from core.accounts where username = new_username) then
      raise exception 'That username is taken.' using errcode = 'RCTKN';
    end if;
    update core.accounts set username = new_username where id = target;
    perform set_config('core.account_write', 'on', true);
    update auth.users set email = core.account_email(new_username), updated_at = now() where id = target;
    perform set_config('core.account_write', '', true);
    update auth.identities set identity_data = identity_data || jsonb_build_object('email', core.account_email(new_username)),
      updated_at = now()
    where user_id = target and provider = 'email';
  end if;
  select to_jsonb(p) - 'id' - 'created_at' - 'updated_at' into before_profile from core.profiles p where id = target;
  if new_display_name is not null or new_avatar is not null then
    update core.profiles set display_name = coalesce(new_display_name, display_name), avatar = coalesce(nullif(new_avatar, ''), avatar)
    where id = target;
  end if;
  insert into core.audit (actor, action, target, detail)
  values ((select auth.uid()), 'edited account', target, jsonb_build_object(
    'username', jsonb_build_array(old.username, coalesce(new_username, old.username)),
    'profile', jsonb_build_array(before_profile, (select to_jsonb(p) - 'id' - 'created_at' - 'updated_at' from core.profiles p where id = target))));
end;
$$;

-- The first superuser's invite: run by hand in the SQL editor (see the top). Nobody can call it through the API.
create function core.first_invite() returns text
language plpgsql security definer set search_path = '' as $$
declare
  code text := core.new_code();
begin
  if exists (select 1 from core.roles where role = 'superuser') then
    raise exception 'There''s already a superuser: they make the invites.' using errcode = '42501';
  end if;
  insert into core.invites (code_hash, role, scope, expires_at) values (core.hash_code(code), 'superuser', '*', now() + interval '1 day');
  return code;
end;
$$;

-- ---------- account sign-ins stay the database's ----------

-- Nobody but make_account and edit_account gives an address of ours to a sign-in, or changes one: signing up with an
-- account's address, or moving an account to a real address, is refused. Those two mark their own writes (a setting
-- for that moment of the transaction, which pages can't set); Supabase's sign-in service and the dashboard can't.
create function core.guard_account_emails() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_setting('core.account_write', true) = 'on' then return new; end if;
  if (new.email ilike '%@users.reclaude.invalid' and (tg_op = 'INSERT' or new.email is distinct from old.email))
     or (coalesce(new.email_change, '') ilike '%@users.reclaude.invalid'
       and (tg_op = 'INSERT' or coalesce(new.email_change, '') <> coalesce(old.email_change, ''))) then
    raise exception 'Accounts are made by core.make_account.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.email ilike '%@users.reclaude.invalid'
     and (new.email is distinct from old.email or coalesce(new.email_change, '') <> coalesce(old.email_change, '')) then
    raise exception 'An account''s address can''t change.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger guard_account_emails before insert or update of email, email_change on auth.users
  for each row execute function core.guard_account_emails();

-- ---------- who can see what ----------

grant select on core.accounts, core.roles to authenticated;
grant select on core.invites, core.audit to authenticated;

create policy "users see their own account; superusers see all" on core.accounts
  for select to authenticated using (id = (select auth.uid()) or (select core.is_superuser()));
create policy "users see their own roles; superusers see all" on core.roles
  for select to authenticated using (user_id = (select auth.uid()) or (select core.is_superuser()));
create policy "superusers see invites" on core.invites
  for select to authenticated using ((select core.is_superuser()));
create policy "superusers see the audit log" on core.audit
  for select to authenticated using ((select core.is_superuser()));

-- A deactivated account can't read or change profiles either.
drop policy "profiles are readable by signed-in users" on core.profiles;
drop policy "users create their own profile" on core.profiles;
drop policy "users edit their own profile" on core.profiles;
create policy "profiles are readable by signed-in users" on core.profiles
  for select to authenticated using ((select core.is_active()));
create policy "users create their own profile" on core.profiles
  for insert to authenticated with check (id = (select auth.uid()) and (select core.is_active()));
create policy "users edit their own profile" on core.profiles
  for update to authenticated using (id = (select auth.uid()) and (select core.is_active()))
  with check (id = (select auth.uid()));

-- What pages may call; everything else in core stays the database's own. (The default privileges in
-- …_core_profiles_clean_names.sql can't do this: per-schema defaults only add to Postgres's, which let anyone run a
-- new function.)
revoke execute on all functions in schema core from public;
grant execute on function core.is_active(), core.has_role(text, text), core.is_superuser(), core.make_account(text, text, text),
  core.change_key(text), core.make_invite(text, text, int), core.cancel_invite(bigint), core.set_active(uuid, boolean),
  core.reset_key(uuid), core.edit_account(uuid, text, text, text) to authenticated;
