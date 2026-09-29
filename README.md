# pg-tenant-rls

Row Level Security for a multi-tenant Postgres, with the tests that try to break it.

[![CI](https://github.com/joshua-angulo/pg-tenant-rls/actions/workflows/ci.yml/badge.svg)](https://github.com/joshua-angulo/pg-tenant-rls/actions/workflows/ci.yml)

This is the isolation layer from LuckAgents, my WhatsApp AI SaaS, cut down to the smallest thing that still runs: three tables, two roles, six policies, 16 tests. Dependencies are `pg` and `vitest`.

## Why it exists

The usual way to keep tenants apart is `where tenant_id = $1` on every query. That has two problems. Forget the clause once and you leak. And, the one that bit me: the clause can be correct and the wrong user still gets in. A suspended member still belongs to the tenant. So does an invited user who never accepted. I found both reading data in my own product during a pre-launch audit. Every endpoint was right; no policy ever asked "is this membership active?".

So the check lives in Postgres. The app sets `app.user_id` on the transaction and writes plain SQL.

## Run it

```bash
docker compose up -d --wait
npm install
npm test
```

Or point `DATABASE_URL` at any Postgres 13+ you can reach as a superuser.

## What the tests check

```
who can read
  an active member sees their tenant's documents, and only those
  a suspended member sees nothing
  an invited member who has not accepted yet sees nothing
  a user with no membership sees nothing
  with no identity in the session nothing is visible: fail closed
  an active member of one tenant cannot reach the other tenant's documents
  a member can see their own memberships even when suspended

who can write
  an active member writes to their own tenant
  cannot insert a document into another tenant
  cannot move an own document into another tenant
  an UPDATE on someone else's documents does not error: it simply reaches no rows
  a DELETE on someone else's documents reaches no rows either

the mechanism itself
  the table owner is also subject to the policies
  a superuser does bypass them, which is why the app must never connect as one
  the application role has neither SUPERUSER nor BYPASSRLS
  if RLS is turned off, the leak appears: the suite detects its own failure
```

The positive test comes first on purpose. Without it, every negative test also passes against an empty table.

I also broke the policies one at a time to see what catches what: removing `force row level security` fails the table-owner test, `with check (true)` on insert fails the cross-tenant insert test, and ignoring membership status fails the suspended and invited tests. Each break trips exactly the test meant for it.

## Notes

- `force row level security`, not just `enable`. `enable` skips the table owner, which is usually the migration role and often the same role serving traffic. Without `force` the policies exist and protect nothing.
- Identity goes in with a parameterized `set_config('app.user_id', $1, true)`. Building that string by hand would be an injection point in the one thing everything depends on.
- `with check` on insert and update, not only `using`. `using` decides what you can see; `with check` decides what you can write. Without it a member can insert a row with another tenant's id, or move their own row out of reach.
- The membership check is `security definer` with a pinned `search_path`, owned by a non-superuser role. Open search paths on definer functions are a known privilege escalation.
- RLS does not error on update or delete of rows you can't see. It filters them out and returns `rowCount: 0`. The app has to check that number or it returns 200 for an update that never happened.

## Not covered

- Transaction-mode pooling (PgBouncer). This uses `set local` inside the transaction, which is the right choice there. A session-level `set` leaks identity between requests when connections are reused.
- Indexes and query plans on big tables. Policies run per row.
- Migrations, authentication, the rest of an app. The server must set `app.user_id` from a session it already authenticated, never from anything the client sends.
