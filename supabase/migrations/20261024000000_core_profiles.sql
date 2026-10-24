-- core: what every app shares. Apps keep their own tables in their own schema and refer to people by
-- core.profiles.id (the Supabase Auth user id); core never refers to an app.
create schema core;
grant usage on schema core to authenticated;

-- One profile per signed-in user (anonymous ones included): the name and avatar every app shows.
-- Any signed-in user can read profiles; each user creates and edits only their own. Names are shown in pages,
-- so < > & and control characters are refused (escape them anyway when building HTML).
create table core.profiles (
  id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  display_name text not null
    check (display_name = btrim(display_name) and char_length(display_name) between 1 and 24
      and display_name !~ '[<>&[:cntrl:]]'),
  avatar text check (char_length(avatar) between 1 and 16 and avatar !~ '[<>&[:cntrl:]]'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table core.profiles enable row level security;

-- Only these columns can be written by users: id and the timestamps are the database's.
grant select on core.profiles to authenticated;
grant insert (id, display_name, avatar) on core.profiles to authenticated;
grant update (display_name, avatar) on core.profiles to authenticated;

create policy "profiles are readable by signed-in users" on core.profiles
  for select to authenticated using (true);
create policy "users create their own profile" on core.profiles
  for insert to authenticated with check (id = (select auth.uid()));
create policy "users edit their own profile" on core.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create function core.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_updated_at before update on core.profiles
  for each row execute function core.touch_updated_at();
