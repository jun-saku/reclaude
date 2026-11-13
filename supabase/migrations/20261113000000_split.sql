-- Split (apps/split/, planned in apps/_split-plan.md): a bill splitter for a group.
--   groups: made by an account, its first owner. A title, an emoji, a currency and optionally a second one with a
--     rate typed by hand (group currency per 1 of it). Owners archive it (read-only) and bring it back.
--   members: the names in the group, added by owners. Nobody needs an account: the group's link shows the names
--     (join_info) and a phone signs in anonymously and claims one (claim); like Trip (…_trip.sql), an account can be
--     linked to a name, owners free names, and a group keeps at least one owner (who has a linked account).
--   categories: labels for bills; a new group gets the defaults; owners add, rename and delete them.
--   bills: added, changed and deleted by anyone in the group. Lines (one for a total split equally; several for an
--     itemized receipt), each shared equally by the members on it; payers, whose amounts add up to the lines'. Who
--     owes whom is worked out by the page from these (apps/split/ledger.js).
--   transfers: money paid from one member to another, for one bill or in general. Made by the one paying (pending
--     until the one paid confirms it) or by the one paid (confirmed at once). Only confirmed ones count.
--   log: every change, with old and new values, written by the function that makes it; owners read it.
--   changes: one row per group, moved on with every change, for pages to follow live (Realtime).
-- All changes go through these functions (tables are read-only to the API). Refusals carry errcode RCSPL and a
-- message written to be shown.

create schema split;
grant usage on schema split to anon, authenticated;

-- ---------- tables ----------

create table split.groups (
  id uuid primary key default gen_random_uuid(),
  title text not null check (title = btrim(title) and char_length(title) between 1 and 60
    and title !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]'),
  emoji text not null default '🧾' check (char_length(emoji) between 1 and 16
    and emoji !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]'),
  currency text not null default 'PHP' check (currency ~ '^[A-Z]{3}$'),
  local_currency text check (local_currency ~ '^[A-Z]{3}$' and local_currency <> currency),
  local_rate numeric(18, 6) check (local_rate > 0),
  join_code text not null unique,
  made_by uuid not null references core.accounts (id),
  made_at timestamptz not null default now(),
  archived_at timestamptz,
  version bigint not null default 0,
  check ((local_currency is null) = (local_rate is null))
);

create table split.members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references split.groups (id) on delete cascade,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 24
    and name !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]'),
  icon text not null default '👤' check (char_length(icon) between 1 and 16
    and icon !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]'),
  user_id uuid,
  account_id uuid references core.accounts (id),
  taken boolean generated always as (user_id is not null or account_id is not null) stored,
  owner boolean not null default false check (not owner or account_id is not null),
  added_at timestamptz not null default now(),
  removed_at timestamptz
);
create index on split.members (group_id);
create index on split.members (user_id);
create index on split.members (account_id);
create unique index members_one_name on split.members (group_id, lower(name)) where removed_at is null;
create unique index members_one_device on split.members (group_id, user_id) where removed_at is null;
create unique index members_one_account on split.members (group_id, account_id) where removed_at is null;

create table split.handovers (
  member_id uuid primary key references split.members (id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null default now() + interval '1 day'
);

create table split.categories (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references split.groups (id) on delete cascade,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 30
    and name !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]'),
  emoji text not null default '🏷️' check (char_length(emoji) between 1 and 16
    and emoji !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]'),
  position int not null default 0
);
create index on split.categories (group_id);
create unique index categories_one_name on split.categories (group_id, lower(name));

create table split.bills (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references split.groups (id) on delete cascade,
  title text not null check (title = btrim(title) and char_length(title) between 1 and 80
    and title !~ '[<>&[:cntrl:]­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]'),
  kind text not null check (kind in ('total', 'itemized')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  category_id uuid references split.categories (id) on delete set null,
  spent_on date not null default current_date,
  note text check (char_length(note) between 1 and 1000),
  made_by uuid references split.members (id),
  made_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on split.bills (group_id, spent_on);

create table split.bill_lines (
  id bigint generated always as identity primary key,
  bill_id uuid not null references split.bills (id) on delete cascade,
  group_id uuid not null references split.groups (id) on delete cascade,
  label text check (char_length(label) between 1 and 80 and label !~ '[<>&[:cntrl:]]'),
  amount numeric(14, 2) not null check (amount > 0),
  members uuid[] not null check (cardinality(members) between 1 and 100),
  position int not null
);
create index on split.bill_lines (bill_id);
create index on split.bill_lines (group_id);

create table split.bill_payers (
  bill_id uuid not null references split.bills (id) on delete cascade,
  member_id uuid not null references split.members (id),
  group_id uuid not null references split.groups (id) on delete cascade,
  amount numeric(14, 2) not null check (amount > 0),
  primary key (bill_id, member_id)
);
create index on split.bill_payers (group_id);

create table split.transfers (
  id bigint generated always as identity primary key,
  group_id uuid not null references split.groups (id) on delete cascade,
  from_member uuid not null references split.members (id),
  to_member uuid not null references split.members (id),
  amount numeric(14, 2) not null check (amount > 0),
  bill_id uuid references split.bills (id) on delete set null,   -- for this bill's share; null: in general
  note text check (char_length(note) between 1 and 200 and note !~ '[<>&[:cntrl:]]'),
  status text not null check (status in ('pending', 'confirmed', 'rejected')),
  made_by uuid not null references split.members (id),
  made_at timestamptz not null default now(),
  decided_at timestamptz,
  check (from_member <> to_member)
);
create index on split.transfers (group_id);

create table split.log (
  id bigint generated always as identity primary key,
  group_id uuid not null references split.groups (id) on delete cascade,
  member_id uuid references split.members (id),
  actor uuid not null,
  action text not null,
  target text,
  detail jsonb,
  at timestamptz not null default now()
);
create index on split.log (group_id, id);

create table split.changes (
  group_id uuid primary key references split.groups (id) on delete cascade,
  version bigint not null default 0,
  at timestamptz not null default now()
);

alter table split.groups enable row level security;
alter table split.members enable row level security;
alter table split.handovers enable row level security;
alter table split.categories enable row level security;
alter table split.bills enable row level security;
alter table split.bill_lines enable row level security;
alter table split.bill_payers enable row level security;
alter table split.transfers enable row level security;
alter table split.log enable row level security;
alter table split.changes enable row level security;

-- ---------- who may do what ----------

-- The signed-in user's member in this group (by device or linked account), or null.
create function split.me(grp uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select m.id from split.members m
  where m.group_id = grp and m.removed_at is null and core.is_active()
    and (m.user_id = (select auth.uid()) or m.account_id = (select auth.uid()))
  order by (m.account_id = (select auth.uid())) desc nulls last
  limit 1;
$$;

create function split.is_member(grp uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select split.me(grp) is not null;
$$;

create function split.is_owner(grp uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select core.is_active() and exists (select 1 from split.members m where m.group_id = grp and m.removed_at is null
    and m.owner and m.account_id = (select auth.uid()));
$$;

create function split.refuse(message text) returns void
language plpgsql volatile set search_path = '' as $$
begin
  raise exception '%', message using errcode = 'RCSPL';
end;
$$;

create function split.not_archived(grp uuid) returns void
language plpgsql stable set search_path = '' as $$
begin
  if exists (select 1 from split.groups g where g.id = grp and g.archived_at is not null) then
    perform split.refuse('This group is archived. An owner can bring it back first.');
  end if;
end;
$$;

-- Someone in the group, and it isn't archived; returns their member id.
create function split.require_member(grp uuid) returns uuid
language plpgsql stable set search_path = '' as $$
declare
  member uuid := split.me(grp);
begin
  if member is null then perform split.refuse('Only people in this group can do that.'); end if;
  perform split.not_archived(grp);
  return member;
end;
$$;

create function split.require_owner(grp uuid, archived_ok boolean default false) returns void
language plpgsql stable set search_path = '' as $$
begin
  if not split.is_owner(grp) then perform split.refuse('Only the group''s owners can do that.'); end if;
  if not archived_ok then perform split.not_archived(grp); end if;
end;
$$;

create function split.member_group(member uuid) returns uuid
language plpgsql stable set search_path = '' as $$
declare
  g uuid := (select m.group_id from split.members m where m.id = member);
begin
  if g is null then perform split.refuse('There''s no such person in this group.'); end if;
  return g;
end;
$$;

create function split.note(grp uuid, action text, target text default null, detail jsonb default null) returns void
language sql volatile set search_path = '' as $$
  insert into split.log (group_id, member_id, actor, action, target, detail)
  values (grp, split.me(grp), (select auth.uid()), action, target, detail);
  update split.groups g set version = g.version + 1 where g.id = grp;
  insert into split.changes (group_id, version) values (grp, 1)
  on conflict (group_id) do update set version = split.changes.version + 1, at = now();
$$;

create function split.group_json(g split.groups) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('title', g.title, 'emoji', g.emoji, 'currency', g.currency,
    'local_currency', g.local_currency, 'local_rate', g.local_rate);
$$;

create function split.member_json(m split.members) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('name', m.name, 'icon', m.icon, 'owner', m.owner);
$$;

-- A bill as the log keeps it: its fields, lines and payers.
create function split.bill_json(bill uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('title', b.title, 'kind', b.kind, 'currency', b.currency, 'category', b.category_id,
    'spent_on', b.spent_on, 'note', b.note,
    'lines', (select jsonb_agg(jsonb_build_object('label', l.label, 'amount', l.amount, 'members', l.members) order by l.position)
      from split.bill_lines l where l.bill_id = b.id),
    'payers', (select jsonb_object_agg(p.member_id, p.amount) from split.bill_payers p where p.bill_id = b.id))
  from split.bills b where b.id = bill;
$$;

-- ---------- groups ----------

create function split.make_group(title text, my_name text, emoji text default null, currency text default 'PHP') returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  new_id uuid;
begin
  if not exists (select 1 from core.accounts a where a.id = me and a.active) then
    perform split.refuse('Sign in to your account to make a group.');
  end if;
  insert into split.groups (title, emoji, currency, join_code, made_by)
  values (title, coalesce(nullif(btrim(emoji), ''), '🧾'), coalesce(currency, 'PHP'), core.new_code(), me)
  returning groups.id into new_id;
  insert into split.members (group_id, name, user_id, account_id, owner) values (new_id, my_name, me, me, true);
  insert into split.categories (group_id, name, emoji, position)
  select new_id, c.name, c.emoji, c.n from (values ('Food', '🍽️', 1), ('Drinks', '🍹', 2), ('Transport', '🚕', 3),
    ('Stay', '🏨', 4), ('Activities', '🎟️', 5), ('Shopping', '🛍️', 6), ('Other', '🏷️', 7)) as c(name, emoji, n);
  perform split.note(new_id, 'group.make', new_id::text, jsonb_build_object('new', (select split.group_json(g) from split.groups g where g.id = new_id)));
  return new_id;
end;
$$;

create function split.edit_group(grp uuid, title text, emoji text, currency text, local_currency text default null,
  local_rate numeric default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  old jsonb;
  new jsonb;
begin
  perform split.require_owner(grp);
  if currency is distinct from (select g.currency from split.groups g where g.id = grp)
      and exists (select 1 from split.bills b where b.group_id = grp) then
    perform split.refuse('The group''s currency can''t change once it has bills.');
  end if;
  if local_currency is distinct from (select g.local_currency from split.groups g where g.id = grp)
      and exists (select 1 from split.bills b join split.groups g on g.id = b.group_id where b.group_id = grp and b.currency = g.local_currency) then
    perform split.refuse('Some bills are in the second currency: it can''t change now (its rate can).');
  end if;
  select split.group_json(g) into old from split.groups g where g.id = grp;
  update split.groups g set title = edit_group.title, emoji = coalesce(nullif(btrim(edit_group.emoji), ''), '🧾'),
    currency = edit_group.currency, local_currency = edit_group.local_currency, local_rate = edit_group.local_rate
  where g.id = grp returning split.group_json(g) into new;
  if new is distinct from old then perform split.note(grp, 'group.edit', grp::text, jsonb_build_object('old', old, 'new', new)); end if;
end;
$$;

create function split.archive_group(grp uuid, archived boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform split.require_owner(grp, true);
  update split.groups g set archived_at = case when archived then coalesce(g.archived_at, now()) end
  where g.id = grp and (g.archived_at is null) = archived;
  if found then perform split.note(grp, case when archived then 'group.archive' else 'group.unarchive' end, grp::text); end if;
end;
$$;

create function split.join_link(grp uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  perform split.require_owner(grp, true);
  return (select g.join_code from split.groups g where g.id = grp);
end;
$$;

create function split.new_join_code(grp uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  code text := core.new_code();
begin
  perform split.require_owner(grp, true);
  update split.groups g set join_code = code where g.id = grp;
  perform split.note(grp, 'group.new_join_code', grp::text);
  return code;
end;
$$;

-- ---------- members (owners) ----------

create function split.add_member(grp uuid, name text, icon text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  new_id uuid;
begin
  perform split.require_owner(grp);
  if exists (select 1 from split.members m where m.group_id = grp and m.removed_at is null and lower(m.name) = lower(btrim(add_member.name))) then
    perform split.refuse('There''s already someone with that name in this group.');
  end if;
  insert into split.members (group_id, name, icon) values (grp, name, coalesce(nullif(btrim(icon), ''), '👤'))
  returning members.id into new_id;
  perform split.note(grp, 'member.add', new_id::text, jsonb_build_object('new', (select split.member_json(m) from split.members m where m.id = new_id)));
  return new_id;
end;
$$;

-- Owners, or the person themselves.
create function split.edit_member(member uuid, name text, icon text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  g uuid := split.member_group(member);
  old jsonb;
  new jsonb;
begin
  if split.me(g) is distinct from member then perform split.require_owner(g); else perform split.not_archived(g); end if;
  if exists (select 1 from split.members m where m.group_id = g and m.id <> member and m.removed_at is null
      and lower(m.name) = lower(btrim(edit_member.name))) then
    perform split.refuse('There''s already someone with that name in this group.');
  end if;
  select split.member_json(m) into old from split.members m where m.id = member;
  update split.members m set name = edit_member.name, icon = coalesce(nullif(btrim(edit_member.icon), ''), '👤')
  where m.id = member returning split.member_json(m) into new;
  if new is distinct from old then perform split.note(g, 'member.edit', member::text, jsonb_build_object('old', old, 'new', new)); end if;
end;
$$;

-- Out of the group (their bills and payments stay, and count), or back in.
create function split.remove_member(member uuid, removed boolean default true) returns void
language plpgsql security definer set search_path = '' as $$
declare
  g uuid := split.member_group(member);
  m split.members;
begin
  perform split.require_owner(g);
  select * into m from split.members x where x.id = member;
  if (m.removed_at is not null) = removed then return; end if;
  if removed and m.owner then perform split.refuse('Make them not an owner first.'); end if;
  if not removed and exists (select 1 from split.members x where x.group_id = g and x.removed_at is null and (lower(x.name) = lower(m.name)
      or x.user_id = m.user_id or x.account_id = m.account_id)) then
    perform split.refuse('Someone in the group has that name or phone now. Change theirs first.');
  end if;
  update split.members x set removed_at = case when removed then now() end where x.id = member;
  perform split.note(g, case when removed then 'member.remove' else 'member.restore' end, member::text);
end;
$$;

create function split.free_member(member uuid, unlink boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare
  g uuid := split.member_group(member);
  m split.members;
begin
  perform split.require_owner(g, true);
  select * into m from split.members x where x.id = member;
  if unlink and m.owner then perform split.refuse('Make them not an owner first.'); end if;
  update split.members x set user_id = null, account_id = case when unlink then null else x.account_id end where x.id = member;
  delete from split.handovers h where h.member_id = member;
  perform split.note(g, 'member.free', member::text, jsonb_build_object('phone', m.user_id is not null, 'account', unlink and m.account_id is not null));
end;
$$;

create function split.set_owner(member uuid, owner boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  g uuid := split.member_group(member);
  m split.members;
begin
  perform split.require_owner(g, true);
  select * into m from split.members x where x.id = member;
  if m.owner = owner then return; end if;
  if m.removed_at is not null then perform split.refuse('They''re not in the group.'); end if;
  if owner and m.account_id is null then perform split.refuse('Only someone with an account linked can be an owner.'); end if;
  if not owner and not exists (select 1 from split.members x where x.group_id = g and x.id <> member and x.owner and x.removed_at is null) then
    perform split.refuse('A group needs at least one owner.');
  end if;
  update split.members x set owner = set_owner.owner where x.id = member;
  perform split.note(g, case when owner then 'member.owner' else 'member.not_owner' end, member::text);
end;
$$;

-- ---------- joining (anyone with the link) ----------

create function split.join_info(code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', g.id, 'title', g.title, 'emoji', g.emoji, 'archived', g.archived_at is not null,
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'icon', m.icon, 'taken', m.taken)
      order by lower(m.name)) from split.members m where m.group_id = g.id and m.removed_at is null), '[]'))
  from split.groups g where g.join_code = core.clean_code(code);
$$;

create function split.claim(code text, member uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  account boolean := exists (select 1 from core.accounts a where a.id = me and a.active);
  g uuid := (select x.id from split.groups x where x.join_code = core.clean_code(code));
  m split.members;
begin
  if me is null or not core.is_active() then perform split.refuse('Sign in first.'); end if;
  if g is null then perform split.refuse('That link doesn''t work any more. Ask for a new one.'); end if;
  select * into m from split.members x where x.id = member and x.group_id = g and x.removed_at is null;
  if not found then perform split.refuse('There''s no such person in this group.'); end if;
  if split.me(g) = member then return g; end if;
  if split.me(g) is not null then perform split.refuse('You''re already someone else in this group. Let that name go first.'); end if;
  if m.user_id is not null or (m.account_id is not null and m.account_id <> me) then
    perform split.refuse('Someone already took that name. If it''s you, ask an owner to free it.');
  end if;
  update split.members x set user_id = me, account_id = case when account then me else x.account_id end where x.id = member;
  perform split.note(g, 'member.claim', member::text, jsonb_build_object('account', account));
  return g;
end;
$$;

create function split.release(grp uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  member uuid := split.me(grp);
  m split.members;
begin
  if member is null then return; end if;
  select * into m from split.members x where x.id = member;
  if m.account_id = me and m.owner then perform split.refuse('Stop being an owner first.'); end if;
  perform split.note(grp, 'member.release', member::text, jsonb_build_object('account', m.account_id = me));
  update split.members x set user_id = case when x.user_id = me then null else x.user_id end,
    account_id = case when x.account_id = me then null else x.account_id end
  where x.id = member;
end;
$$;

create function split.handover_code(grp uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  member uuid := split.me(grp);
  code text := core.new_code();
begin
  if member is null then perform split.refuse('Only people in this group can do that.'); end if;
  insert into split.handovers (member_id, code_hash) values (member, core.hash_code(code))
  on conflict (member_id) do update set code_hash = excluded.code_hash, expires_at = now() + interval '1 day';
  return code;
end;
$$;

create function split.take_over(code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  member uuid;
  g uuid;
begin
  if not exists (select 1 from core.accounts a where a.id = me and a.active) then
    perform split.refuse('Sign in to your account first.');
  end if;
  select h.member_id into member from split.handovers h where h.code_hash = core.hash_code(code) and h.expires_at > now();
  if member is null then perform split.refuse('That code doesn''t work any more.'); end if;
  delete from split.handovers h where h.member_id = member;
  select m.group_id into g from split.members m where m.id = member and m.removed_at is null;
  if g is null then perform split.refuse('That name isn''t in the group any more.'); end if;
  if split.me(g) = member then return g; end if;
  if split.me(g) is not null then perform split.refuse('Your account is already someone else in this group.'); end if;
  if exists (select 1 from split.members m where m.id = member and m.account_id is not null and m.account_id <> me) then
    perform split.refuse('Another account is already linked to that name.');
  end if;
  update split.members m set account_id = me where m.id = member;
  perform split.note(g, 'member.link', member::text);
  return g;
end;
$$;

-- The groups this user is in, newest first: [{ id, title, emoji, archived, me, owner }].
create function split.my_groups() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'title', g.title, 'emoji', g.emoji, 'archived', g.archived_at is not null,
    'me', split.me(g.id), 'owner', split.is_owner(g.id)) order by g.made_at desc), '[]')
  from split.groups g where split.is_member(g.id);
$$;

-- ---------- categories (owners) ----------

create function split.add_category(grp uuid, name text, emoji text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  new_id uuid;
begin
  perform split.require_owner(grp);
  if exists (select 1 from split.categories c where c.group_id = grp and lower(c.name) = lower(btrim(add_category.name))) then
    perform split.refuse('There''s already a category with that name.');
  end if;
  insert into split.categories (group_id, name, emoji, position)
  values (grp, name, coalesce(nullif(btrim(emoji), ''), '🏷️'), coalesce((select max(c.position) + 1 from split.categories c where c.group_id = grp), 1))
  returning categories.id into new_id;
  perform split.note(grp, 'category.add', new_id::text, jsonb_build_object('new', jsonb_build_object('name', name, 'emoji', emoji)));
  return new_id;
end;
$$;

create function split.edit_category(category uuid, name text, emoji text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c split.categories;
begin
  select * into c from split.categories x where x.id = category;
  if not found then perform split.refuse('That category isn''t there any more.'); end if;
  perform split.require_owner(c.group_id);
  if exists (select 1 from split.categories x where x.group_id = c.group_id and x.id <> category and lower(x.name) = lower(btrim(edit_category.name))) then
    perform split.refuse('There''s already a category with that name.');
  end if;
  update split.categories x set name = edit_category.name, emoji = coalesce(nullif(btrim(edit_category.emoji), ''), '🏷️') where x.id = category;
  perform split.note(c.group_id, 'category.edit', category::text, jsonb_build_object('old', jsonb_build_object('name', c.name, 'emoji', c.emoji),
    'new', jsonb_build_object('name', name, 'emoji', emoji)));
end;
$$;

-- Its bills keep no category.
create function split.delete_category(category uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c split.categories;
begin
  select * into c from split.categories x where x.id = category;
  if not found then return; end if;
  perform split.require_owner(c.group_id);
  perform split.note(c.group_id, 'category.delete', category::text, jsonb_build_object('old', jsonb_build_object('name', c.name, 'emoji', c.emoji)));
  delete from split.categories x where x.id = category;
end;
$$;

-- ---------- bills (anyone in the group) ----------

-- Adds a bill (bill null) or replaces one, from:
--   { title, kind: 'total' | 'itemized', currency, category, spent_on, note,
--     lines: [{ label, amount, members: [ids] }] (one for 'total'), payers: { <member id>: amount } }
-- The payers add up to the lines. Returns the bill's id.
create function split.save_bill(grp uuid, bill uuid, fields jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := split.require_member(grp);
  g split.groups;
  bkind text := fields ->> 'kind';
  cur text := fields ->> 'currency';
  lines jsonb := fields -> 'lines';
  payers jsonb := fields -> 'payers';
  total numeric;
  paid numeric;
  old jsonb;
  bid uuid := bill;
begin
  select * into g from split.groups x where x.id = grp;
  if jsonb_typeof(fields) <> 'object' or exists (select 1 from jsonb_object_keys(fields) k
      where k not in ('title', 'kind', 'currency', 'category', 'spent_on', 'note', 'lines', 'payers')) then
    perform split.refuse('Something went wrong. Try again.');
  end if;
  if cur is null or cur not in (g.currency, coalesce(g.local_currency, g.currency)) then
    perform split.refuse('Use the group''s currency.');
  end if;
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) not between 1 and 100
      or (bkind = 'total' and jsonb_array_length(lines) <> 1) then
    perform split.refuse('A bill has its amount (or, itemized, 1 to 100 lines).');
  end if;
  if exists (select 1 from jsonb_array_elements(lines) l
      where jsonb_typeof(l -> 'members') is distinct from 'array' or jsonb_array_length(l -> 'members') = 0
        or exists (select 1 from jsonb_array_elements_text(l -> 'members') x
          where not exists (select 1 from split.members m where m.group_id = grp and m.id::text = x))) then
    perform split.refuse('Each amount is shared by people in the group.');
  end if;
  if jsonb_typeof(payers) is distinct from 'object' or not exists (select 1 from jsonb_object_keys(payers))
      or exists (select 1 from jsonb_object_keys(payers) x where not exists (select 1 from split.members m where m.group_id = grp and m.id::text = x)) then
    perform split.refuse('Say who paid.');
  end if;
  select sum((l ->> 'amount')::numeric) into total from jsonb_array_elements(lines) l;
  select sum(value::numeric) into paid from jsonb_each_text(payers);
  if total is null or paid is null or round(total, 2) <> round(paid, 2) then
    perform split.refuse('What was paid has to add up to the bill.');
  end if;
  if (fields ->> 'category') is not null and not exists (select 1 from split.categories c where c.group_id = grp and c.id::text = fields ->> 'category') then
    perform split.refuse('That category isn''t there any more.');
  end if;
  if bid is null then
    insert into split.bills (group_id, title, kind, currency, category_id, spent_on, note, made_by)
    values (grp, fields ->> 'title', bkind, cur, (fields ->> 'category')::uuid, coalesce((fields ->> 'spent_on')::date, current_date),
      nullif(btrim(fields ->> 'note'), ''), me)
    returning bills.id into bid;
  else
    if not exists (select 1 from split.bills b where b.id = bid and b.group_id = grp) then perform split.refuse('That bill isn''t there any more.'); end if;
    old := split.bill_json(bid);
    update split.bills b set title = fields ->> 'title', kind = bkind, currency = cur, category_id = (fields ->> 'category')::uuid,
      spent_on = coalesce((fields ->> 'spent_on')::date, b.spent_on), note = nullif(btrim(fields ->> 'note'), ''), updated_at = now()
    where b.id = bid;
    delete from split.bill_lines l where l.bill_id = bid;
    delete from split.bill_payers p where p.bill_id = bid;
  end if;
  insert into split.bill_lines (bill_id, group_id, label, amount, members, position)
  select bid, grp, nullif(btrim(l.value ->> 'label'), ''), (l.value ->> 'amount')::numeric,
    (select array_agg(distinct x::uuid) from jsonb_array_elements_text(l.value -> 'members') x), l.ordinality
  from jsonb_array_elements(lines) with ordinality l;
  insert into split.bill_payers (bill_id, member_id, group_id, amount)
  select bid, p.key::uuid, grp, p.value::numeric from jsonb_each_text(payers) p where p.value::numeric > 0;
  perform split.note(grp, case when old is null then 'bill.add' else 'bill.edit' end, bid::text,
    jsonb_strip_nulls(jsonb_build_object('old', old, 'new', split.bill_json(bid))));
  return bid;
end;
$$;

create function split.delete_bill(bill uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  g uuid := (select b.group_id from split.bills b where b.id = bill);
begin
  if g is null then return; end if;
  perform split.require_member(g);
  perform split.note(g, 'bill.delete', bill::text, jsonb_build_object('old', split.bill_json(bill)));
  delete from split.bills b where b.id = bill;
end;
$$;

-- ---------- paying (transfers) ----------

-- Money from one member to another (in the group's currency), for one bill or in general. Made by the one paying:
-- pending until the one paid confirms; by the one paid: confirmed at once. Returns its id.
create function split.record_transfer(grp uuid, from_member uuid, to_member uuid, amount numeric, bill uuid default null,
  note text default null) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := split.require_member(grp);
  new_id bigint;
begin
  if me not in (from_member, to_member) then perform split.refuse('Only the one paying or the one paid can record it.'); end if;
  if not exists (select 1 from split.members m where m.id = from_member and m.group_id = grp)
      or not exists (select 1 from split.members m where m.id = to_member and m.group_id = grp) then
    perform split.refuse('There''s no such person in this group.');
  end if;
  if bill is not null and not exists (select 1 from split.bills b where b.id = bill and b.group_id = grp) then
    perform split.refuse('That bill isn''t there any more.');
  end if;
  insert into split.transfers (group_id, from_member, to_member, amount, bill_id, note, status, made_by, decided_at)
  values (grp, from_member, to_member, round(amount, 2), bill, nullif(btrim(note), ''),
    case when me = to_member then 'confirmed' else 'pending' end, me, case when me = to_member then now() end)
  returning transfers.id into new_id;
  perform split.note(grp, 'transfer.add', new_id::text, jsonb_build_object('from', from_member, 'to', to_member,
    'amount', round(amount, 2), 'bill', bill, 'status', case when me = to_member then 'confirmed' else 'pending' end));
  return new_id;
end;
$$;

-- The one paid confirms a pending transfer (received) or rejects it (not received).
create function split.decide_transfer(transfer bigint, received boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t split.transfers;
begin
  select * into t from split.transfers x where x.id = transfer;
  if not found then perform split.refuse('That payment isn''t there any more.'); end if;
  if split.require_member(t.group_id) <> t.to_member then perform split.refuse('Only the one paid can confirm it.'); end if;
  if t.status <> 'pending' then perform split.refuse('That payment was already answered.'); end if;
  update split.transfers x set status = case when received then 'confirmed' else 'rejected' end, decided_at = now() where x.id = transfer;
  perform split.note(t.group_id, case when received then 'transfer.confirm' else 'transfer.reject' end, transfer::text,
    jsonb_build_object('from', t.from_member, 'to', t.to_member, 'amount', t.amount));
end;
$$;

-- Takes a payment back: the one paying while it's pending, or the one paid at any time.
create function split.cancel_transfer(transfer bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t split.transfers;
  me uuid;
begin
  select * into t from split.transfers x where x.id = transfer;
  if not found then return; end if;
  me := split.require_member(t.group_id);
  if not (me = t.to_member or (me = t.from_member and t.status = 'pending')) then
    perform split.refuse('Only the one paid can take back a confirmed payment.');
  end if;
  perform split.note(t.group_id, 'transfer.cancel', transfer::text, jsonb_build_object('from', t.from_member, 'to', t.to_member,
    'amount', t.amount, 'status', t.status, 'bill', t.bill_id));
  delete from split.transfers x where x.id = transfer;
end;
$$;

-- ---------- reading ----------

grant select (id, title, emoji, currency, local_currency, local_rate, made_by, made_at, archived_at, version) on split.groups to authenticated;
grant select (id, group_id, name, icon, taken, owner, added_at, removed_at) on split.members to authenticated;
grant select on split.categories, split.bills, split.bill_lines, split.bill_payers, split.transfers, split.log, split.changes to authenticated;
create policy "members read the group" on split.groups for select to authenticated using ((select split.is_member(id)));
create policy "members read its people" on split.members for select to authenticated using ((select split.is_member(group_id)));
create policy "members read its categories" on split.categories for select to authenticated using ((select split.is_member(group_id)));
create policy "members read its bills" on split.bills for select to authenticated using ((select split.is_member(group_id)));
create policy "members read its bill lines" on split.bill_lines for select to authenticated using ((select split.is_member(group_id)));
create policy "members read its payers" on split.bill_payers for select to authenticated using ((select split.is_member(group_id)));
create policy "members read its payments" on split.transfers for select to authenticated using ((select split.is_member(group_id)));
create policy "members follow its changes" on split.changes for select to authenticated using ((select split.is_member(group_id)));
create policy "owners read the log" on split.log for select to authenticated using ((select split.is_owner(group_id)));

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table split.changes;
  end if;
end $$;

revoke execute on all functions in schema split from public;
alter default privileges in schema split revoke execute on functions from public;
grant execute on function split.me(uuid), split.is_member(uuid), split.is_owner(uuid),
  split.make_group(text, text, text, text), split.edit_group(uuid, text, text, text, text, numeric),
  split.archive_group(uuid, boolean), split.join_link(uuid), split.new_join_code(uuid),
  split.add_member(uuid, text, text), split.edit_member(uuid, text, text), split.remove_member(uuid, boolean),
  split.free_member(uuid, boolean), split.set_owner(uuid, boolean),
  split.join_info(text), split.claim(text, uuid), split.release(uuid), split.handover_code(uuid), split.take_over(text),
  split.my_groups(), split.add_category(uuid, text, text), split.edit_category(uuid, text, text), split.delete_category(uuid),
  split.save_bill(uuid, uuid, jsonb), split.delete_bill(uuid),
  split.record_transfer(uuid, uuid, uuid, numeric, uuid, text), split.decide_transfer(bigint, boolean),
  split.cancel_transfer(bigint) to authenticated;
grant execute on function split.join_info(text) to anon;
