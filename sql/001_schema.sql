-- Tenants, memberships with a status, and documents that belong to a tenant.
-- `invited` and `suspended` members must not read anything, even though they
-- belong to the tenant. A `where tenant_id = $1` in the app doesn't catch that.

-- app_owner owns the tables and the membership check. Not a superuser, on purpose.
-- app_user is what the API connects as: no SUPERUSER, no BYPASSRLS. The tests check both.
create role app_owner nologin;
create role app_user nologin;

create type membership_status as enum ('active', 'invited', 'suspended');

create table tenants (
    id   uuid primary key default gen_random_uuid(),
    name text not null
);

create table memberships (
    user_id   uuid not null,
    tenant_id uuid not null references tenants (id) on delete cascade,
    status    membership_status not null,
    primary key (user_id, tenant_id)
);

create table documents (
    id        uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants (id) on delete cascade,
    title     text not null,
    body      text not null default ''
);

create index documents_tenant_idx on documents (tenant_id);

alter type membership_status owner to app_owner;
alter table tenants owner to app_owner;
alter table memberships owner to app_owner;
alter table documents owner to app_owner;

grant usage on schema public to app_user;
grant select, insert, update, delete on tenants, memberships, documents to app_user;
