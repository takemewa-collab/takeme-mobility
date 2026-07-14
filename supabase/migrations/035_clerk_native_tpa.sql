-- 035: Native Clerk third-party auth.
--
-- Clerk is registered as a third-party auth provider on this project
-- (issuer https://clerk.takememobility.com), so PostgREST/realtime accept
-- Clerk session JWTs directly. Those tokens carry the Clerk user id
-- (`user_...`) as `sub`, which auth.uid() casts to uuid — every policy
-- built on auth.uid() would raise 22P02 for a Clerk caller. This migration
-- introduces a Clerk→Supabase identity bridge and rewrites the policies to
-- a cast-safe resolver, keeping behaviour identical for uuid subs (web
-- cookie sessions, any legacy GoTrue tokens).

-- 1. Bridge: which Supabase auth user a Clerk identity maps to. Rows are
--    written only by the platform (service role) on first sign-in.
create table if not exists public.clerk_links (
  clerk_id text primary key,
  user_id uuid not null unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.clerk_links enable row level security;

drop policy if exists clerk_links_service on public.clerk_links;
create policy clerk_links_service on public.clerk_links
  for all to service_role using (true) with check (true);

-- 2. Contact lookups so pre-Clerk accounts keep their history when the same
--    person signs in through Clerk. Service-role only: they read auth.users.
create or replace function public.user_id_for_phone(p_phone text)
returns uuid
language sql stable security definer
set search_path = public, auth
as $$
  select id from auth.users where phone = p_phone limit 1;
$$;

create or replace function public.user_id_for_email(p_email text)
returns uuid
language sql stable security definer
set search_path = public, auth
as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1;
$$;

revoke execute on function public.user_id_for_phone(text) from public, anon, authenticated;
revoke execute on function public.user_id_for_email(text) from public, anon, authenticated;
grant execute on function public.user_id_for_phone(text) to service_role;
grant execute on function public.user_id_for_email(text) to service_role;

-- 3. Cast-safe caller resolution: uuid subs pass through, Clerk subs resolve
--    through clerk_links, anything else is null (fail closed).
create or replace function public.app_user_id()
returns uuid
language plpgsql stable security definer
set search_path = public
as $$
declare
  s text := coalesce(auth.jwt() ->> 'sub', '');
begin
  if s = '' then
    return null;
  elsif s ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return s::uuid;
  else
    return (select user_id from public.clerk_links where clerk_id = s);
  end if;
end;
$$;

grant execute on function public.app_user_id() to anon, authenticated, service_role;

-- 4. get_driver_id() is the drivers' policy helper; route it through the
--    same resolver.
create or replace function public.get_driver_id()
returns uuid
language sql stable security definer
as $$
  select id from drivers where auth_user_id = public.app_user_id() limit 1;
$$;

-- 5. Rewrite every policy that references auth.uid(). The replacement is
--    wrapped in a scalar subquery so the planner evaluates it once per
--    statement (initplan), same as the auth.uid() idiom.
do $$
declare
  r record;
  stmt text;
begin
  for r in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') like '%auth.uid()%'
        or coalesce(with_check, '') like '%auth.uid()%')
  loop
    stmt := format('alter policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    if r.qual is not null then
      stmt := stmt || ' using (' || replace(r.qual, 'auth.uid()', '(select public.app_user_id())') || ')';
    end if;
    if r.with_check is not null then
      stmt := stmt || ' with check (' || replace(r.with_check, 'auth.uid()', '(select public.app_user_id())') || ')';
    end if;
    execute stmt;
  end loop;

  -- No policy may still depend on the cast-unsafe auth.uid().
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') like '%auth.uid()%'
        or coalesce(with_check, '') like '%auth.uid()%')
  ) then
    raise exception 'auth.uid() policies remain after rewrite';
  end if;
end;
$$;
