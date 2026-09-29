-- Tenant isolation in the database.
--
-- `force row level security`, not just `enable`: `enable` skips the table owner.
-- The app sets `app.user_id` per transaction; the server sets it, never the client.
-- The membership check is `security definer` with a pinned search_path.

create or replace function app_user_id() returns uuid
    language sql
    stable
as $$
    select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function is_active_member(target_tenant uuid) returns boolean
    language sql
    stable
    security definer
    set search_path = public, pg_temp
as $$
    select exists (
        select 1
        from memberships m
        where m.tenant_id = target_tenant
          and m.user_id = app_user_id()
          and m.status = 'active'
    )
$$;

alter function app_user_id() owner to app_owner;
alter function is_active_member(uuid) owner to app_owner;

revoke all on function is_active_member(uuid) from public;
grant execute on function app_user_id() to app_user;
grant execute on function is_active_member(uuid) to app_user;

-- Documents.
alter table documents enable row level security;
alter table documents force row level security;

create policy documents_select on documents
    for select using (is_active_member(tenant_id));

-- `using` limits what you can see; `with check` limits what you can write.
-- Without it a member could insert a row with another tenant's id.
create policy documents_insert on documents
    for insert with check (is_active_member(tenant_id));

create policy documents_update on documents
    for update using (is_active_member(tenant_id))
            with check (is_active_member(tenant_id));

create policy documents_delete on documents
    for delete using (is_active_member(tenant_id));

-- Memberships: you see your own, whatever the status (a suspended user should know it).
alter table memberships enable row level security;
alter table memberships force row level security;

create policy memberships_self on memberships
    for select using (user_id = app_user_id());

-- Tenants: visible to active members only.
alter table tenants enable row level security;
alter table tenants force row level security;

create policy tenants_member on tenants
    for select using (is_active_member(id));
