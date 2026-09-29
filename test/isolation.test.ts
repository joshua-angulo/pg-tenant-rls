import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { asAppUser, asMigrator, asOwner, createPool, migrate } from '../src/db.js'
import { FIXTURE, seed } from '../src/seed.js'

let pool: pg.Pool

beforeAll(async () => {
    pool = createPool()
    await migrate(pool)
    await seed(pool)
}, 30_000)

afterAll(async () => {
    await pool.end()
})

/** First row of a result that always has one. */
const one = <T,>(rows: T[]): T => {
    const [row] = rows
    if (!row) throw new Error('query returned no rows')
    return row
}

const countDocuments = async (userId: string | null): Promise<number> =>
    asAppUser(pool, userId, async (client) => {
        const { rows } = await client.query<{ count: string }>('select count(*) from documents')
        return Number(one(rows).count)
    })

describe('who can read', () => {
    // Positive test first: without it, every negative test below would also pass on an empty table.
    it("an active member sees their tenant's documents, and only those", async () => {
        const titles = await asAppUser(pool, FIXTURE.activeInAcme, async (client) => {
            const { rows } = await client.query<{ title: string }>(
                'select title from documents order by title',
            )
            return rows.map((r) => r.title)
        })
        expect(titles).toEqual(['Contrato Acme', 'Nómina Acme'])
    })

    it('a suspended member sees nothing', async () => {
        // The bug that started this: the tenant filter was right and a suspended user could still read.
        expect(await countDocuments(FIXTURE.suspendedInAcme)).toBe(0)
    })

    it('an invited member who has not accepted yet sees nothing', async () => {
        expect(await countDocuments(FIXTURE.invitedInAcme)).toBe(0)
    })

    it('a user with no membership sees nothing', async () => {
        expect(await countDocuments(FIXTURE.strangerUser)).toBe(0)
    })

    it('with no identity in the session nothing is visible: fail closed', async () => {
        // If the app forgets to set app.user_id, the answer must be zero rows, not the whole table.
        expect(await countDocuments(null)).toBe(0)
    })

    it("an active member of one tenant cannot reach the other tenant's documents", async () => {
        const visible = await asAppUser(pool, FIXTURE.activeInGlobex, async (client) => {
            const { rows } = await client.query<{ title: string }>('select title from documents')
            return rows.map((r) => r.title)
        })
        expect(visible).toEqual(['Contrato Globex'])
    })

    it('a member can see their own memberships even when suspended', async () => {
        // Otherwise the UI couldn't tell a suspended user why they see nothing.
        const statuses = await asAppUser(pool, FIXTURE.suspendedInAcme, async (client) => {
            const { rows } = await client.query<{ status: string }>('select status from memberships')
            return rows.map((r) => r.status)
        })
        expect(statuses).toEqual(['suspended'])
    })
})

describe('who can write', () => {
    it('an active member writes to their own tenant', async () => {
        const inserted = await asAppUser(pool, FIXTURE.activeInAcme, async (client) => {
            const { rowCount } = await client.query(
                'insert into documents (tenant_id, title) values ($1, $2)',
                [FIXTURE.tenantAcme, 'Acta Acme'],
            )
            return rowCount
        })
        expect(inserted).toBe(1)
    })

    it('cannot insert a document into another tenant', async () => {
        // This would pass without `with check` on the insert policy.
        await expect(
            asAppUser(pool, FIXTURE.activeInAcme, (client) =>
                client.query('insert into documents (tenant_id, title) values ($1, $2)', [
                    FIXTURE.tenantGlobex,
                    'Documento infiltrado',
                ]),
            ),
        ).rejects.toThrow(/row-level security/i)
    })

    it('cannot move an own document into another tenant', async () => {
        await expect(
            asAppUser(pool, FIXTURE.activeInAcme, (client) =>
                client.query('update documents set tenant_id = $1 where title = $2', [
                    FIXTURE.tenantGlobex,
                    'Contrato Acme',
                ]),
            ),
        ).rejects.toThrow(/row-level security/i)
    })

    it("an UPDATE on someone else's documents does not error: it simply reaches no rows", async () => {
        // RLS doesn't throw on rows you can't see; it filters them. The app has to check rowCount.
        const affected = await asAppUser(pool, FIXTURE.activeInGlobex, async (client) => {
            const { rowCount } = await client.query(
                'update documents set title = $1 where title = $2',
                ['Secuestrado', 'Contrato Acme'],
            )
            return rowCount
        })
        expect(affected).toBe(0)
    })

    it("a DELETE on someone else's documents reaches no rows either", async () => {
        const affected = await asAppUser(pool, FIXTURE.activeInGlobex, async (client) => {
            const { rowCount } = await client.query('delete from documents where title = $1', [
                'Contrato Acme',
            ])
            return rowCount
        })
        expect(affected).toBe(0)
    })
})

describe('the mechanism itself', () => {
    it('the table owner is also subject to the policies', async () => {
        // This is what `force` buys. With only `enable`, the owner would see all three rows.
        const visible = await asOwner(pool, async (client) => {
            const { rows } = await client.query<{ count: string }>('select count(*) from documents')
            return Number(one(rows).count)
        })
        expect(visible).toBe(0)
    })

    it('a superuser does bypass them, which is why the app must never connect as one', async () => {
        const visible = await asMigrator(pool, async (client) => {
            const { rows } = await client.query<{ count: string }>('select count(*) from documents')
            return Number(one(rows).count)
        })
        expect(visible).toBe(3)
    })

    it('the application role has neither SUPERUSER nor BYPASSRLS', async () => {
        // Either attribute silently turns off every policy here, so CI should fail if one appears.
        const attrs = await asMigrator(pool, async (client) => {
            const { rows } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
                'select rolsuper, rolbypassrls from pg_roles where rolname = $1',
                ['app_user'],
            )
            return one(rows)
        })
        expect(attrs).toEqual({ rolsuper: false, rolbypassrls: false })
    })

    it('if RLS is turned off, the leak appears: the suite detects its own failure', async () => {
        // Turn RLS off inside a rolled-back transaction and check the leak shows up.
        const client = await pool.connect()
        try {
            await client.query('begin')
            await client.query('alter table documents disable row level security')
            await client.query('set local role app_user')
            await client.query('select set_config($1, $2, true)', [
                'app.user_id',
                FIXTURE.suspendedInAcme,
            ])
            const { rows } = await client.query<{ count: string }>('select count(*) from documents')
            expect(Number(one(rows).count)).toBe(3)
        } finally {
            await client.query('rollback').catch(() => undefined)
            client.release()
        }
    })
})
