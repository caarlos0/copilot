---
name: sql
description: Diagnose and fix SQL performance in SQLite and PostgreSQL. Use for slow queries, query plans, index design, pagination, N+1 queries, bulk writes, locking, and schema migrations on large tables.
---

# SQL

Measure first. Preserve results. Change one thing at a time.

Load the reference for the engine in use, relative to this skill directory:

- SQLite: `sqlite.md`
- PostgreSQL: `postgresql.md`

If the engine is unknown, find it in the driver, connection string, or
migration files before you give engine-specific advice.

## Workflow

1. Identify the slow statement and how it is called: parameters, frequency,
   concurrency, and the latency that matters.
2. Reproduce with representative row counts, value distributions, and
   parameters. A plan on a 100-row table does not predict a plan on 100 million
   rows.
3. Capture a baseline: the plan and the end-to-end timing. Plans exclude network
   transfer and client work. Record warm-cache and cold-cache results
   separately.
4. Find the dominant cost in the plan: full scans of large tables, row-estimate
   errors, temporary sorts, repeated inner loops, or lock waits.
5. Make one change: rewrite, index, statistics, schema, or setting.
6. Re-measure under the same conditions. Keep the change only if the gain is
   real and the results are identical.
7. Check the write cost of a new index and the effect on other queries that use
   the same table.

Do not tune settings before the query and indexes are correct. A setting change
affects every query.

## Safety

- Plan inspection is safe. Execution is not. PostgreSQL `EXPLAIN ANALYZE`
  runs the statement. Wrap writes in `BEGIN` and `ROLLBACK`, and prefer an
  isolated copy of the data. A rollback does not undo sequence increments,
  external side effects, load, or lock waits.
- Do not run index builds, `VACUUM`, `ANALYZE`, or DDL on a production database
  without an explicit request.
- For schema changes on large tables, state the lock taken, whether the table is
  rewritten, the expected duration, and the rollback plan.

## Sargable predicates

An index can seek only when the predicate compares the indexed column or
expression directly.

| Avoid | Prefer |
| --- | --- |
| `WHERE date(created_at) = '2026-01-01'` | `WHERE created_at >= '2026-01-01' AND created_at < '2026-01-02'` |
| `WHERE lower(email) = ?` with an index on `email` | An expression index on `lower(email)`, or a case-insensitive collation |
| `WHERE name LIKE '%term'` | A full-text or trigram index; a B-tree cannot seek on a leading wildcard |
| `WHERE id = '42'` on an integer column | Bind the value with the column type |

Moving a cast from the column to the parameter can change results, for example
for strings such as `'042'`. Check the semantics before you rewrite.

## Index design

- Put equality columns first, then at most one range column. This is a starting
  point, not a law. Choose the equality order that serves the most queries.
- An index that matches the `ORDER BY` can remove a sort and make `LIMIT` stop
  early.
- A covering index avoids table lookups. It costs space and write time.
- Partial indexes help when queries always filter on the same predicate. The
  query must imply the index predicate.
- Expression indexes must match the query expression exactly.
- Every index slows inserts, updates of indexed columns, and deletes. Remove an
  index only after you confirm that no constraint or rare critical query needs
  it.
- Do not add an index for each slow query. Prefer one index that serves several
  queries.

## Query shape

- Select only the columns you need. `SELECT *` transfers more data and prevents
  covering index use.
- N+1 queries cost one network round trip each on client/server databases such
  as PostgreSQL. Use a join, `IN`/`ANY` batch, or ORM eager loading, then
  measure. In SQLite, N+1 queries are often acceptable because there is no round
  trip.
- Deep `OFFSET` reads and discards every skipped row. Use keyset pagination with
  a unique tie-breaker and a matching index:

  ```sql
  SELECT id, created_at, title
  FROM posts
  WHERE (created_at, id) < (?, ?)
  ORDER BY created_at DESC, id DESC
  LIMIT 50;
  ```

  Handle nullable keys explicitly. Row values need SQLite 3.15.0 or later.
- Exact `COUNT(*)` reads a table or an index. Cache or estimate counts when
  exact values are not required.
- Batch writes in one transaction. One transaction per row is the most common
  write bottleneck.

## Rewrites that change results

Check each rewrite with test data that has duplicates, NULLs, and unmatched
rows.

- `OR` to `UNION ALL` returns rows that match both branches twice. `UNION`
  removes legitimate duplicate rows.
- `NOT IN (subquery)` returns no rows when the subquery returns a NULL.
  `NOT EXISTS` does not. They are not interchangeable.
- A join can multiply rows that `EXISTS` returns once.
- Removing `DISTINCT` or changing `LEFT JOIN` to `JOIN` can change results.
- Removing `ORDER BY` makes row order undefined, which breaks pagination.

## Report

For each change, give:

1. The statement and the plan before the change, with the dominant cost.
2. The change and why it addresses that cost.
3. The plan and timing after the change, measured the same way.
4. The write, storage, and lock cost.
5. How you verified that results did not change.

State which measurements you did not run.
