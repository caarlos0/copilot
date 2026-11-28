# PostgreSQL

Use with `SKILL.md`. Check the server version first with `SHOW server_version;`.
Several behaviors below depend on it.

## Read the plan

```sql
EXPLAIN SELECT ...;                       -- estimates only; does not run
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;    -- runs the statement
```

For writes:

```sql
BEGIN;
EXPLAIN (ANALYZE, BUFFERS) UPDATE ...;
ROLLBACK;
```

The rollback does not undo sequence increments, and the statement still takes
locks and causes load. Prefer an isolated copy of the data.

- `BUFFERS` is on by default with `ANALYZE` from PostgreSQL 18. Write it
  explicitly for older versions.
- Compare estimated rows with actual rows. A large difference usually means
  missing or stale statistics, or correlated columns.
- Actual rows and time are per loop. Multiply by `loops` for the total.
- `Seq Scan` reads the table. `Index Scan` reads index and heap.
  `Index Only Scan` skips the heap unless `Heap Fetches` is high, which means
  the visibility map is stale: vacuum the table. `Bitmap Heap Scan` collects
  row locations, then reads heap pages in order.
- `Nested Loop` repeats the inner side for each outer row. It is bad only when
  the outer side is large. `Hash Join` builds a hash table. `Merge Join` needs
  sorted inputs.
- `Sort Method: external merge` means the sort spilled to disk. A matching
  index can remove the sort; a larger `work_mem` can keep it in memory.
- A `JIT` section with a large time on a short query means JIT costs more than
  it saves. Test with `SET jit = off`.

Sources: <https://www.postgresql.org/docs/current/using-explain.html>,
<https://www.postgresql.org/docs/current/sql-explain.html>,
<https://www.postgresql.org/docs/current/jit-decision.html>.

## Find slow queries

- `pg_stat_statements` needs `shared_preload_libraries`, a restart, and
  `CREATE EXTENSION pg_stat_statements` in the database. Sort by
  `total_exec_time` to find total load and by `mean_exec_time` to find slow
  calls. Compare `shared_blks_read` with `shared_blks_hit`.
- `auto_explain` logs plans of statements slower than
  `auto_explain.log_min_duration`. `log_analyze` adds per-node timing overhead
  to every statement; use `log_timing = off` or `sample_rate` to reduce it.
- `pg_stat_activity` shows running queries, waits, and transaction age.

Sources: <https://www.postgresql.org/docs/current/pgstatstatements.html>,
<https://www.postgresql.org/docs/current/auto-explain.html>.

## Index types

| Type | Use for |
| --- | --- |
| B-tree | Equality, ranges, sorting. The default. |
| Hash | Equality only. |
| GIN | Values that contain elements: arrays, `jsonb`, full-text, trigram (`pg_trgm`). |
| GiST | Geometry, ranges, nearest-neighbor, some full-text. |
| SP-GiST | Partitioned structures such as tries and quadtrees. |
| BRIN | Very large tables where values follow physical order, such as append-only timestamps. |

Source: <https://www.postgresql.org/docs/current/indexes-types.html>.

## Index design

- Multicolumn B-tree: equality columns first, then the first range column.
  PostgreSQL 18 can skip-scan when leading columns have no condition.
- `INCLUDE (cols)` adds payload columns for index-only scans. They are not
  search keys.
- Partial indexes help when queries always use the same predicate. A generic
  plan for a prepared statement can prevent the planner from proving the
  predicate.
- Expression indexes (`lower(email)`) need immutable functions and an exact
  match in the query.
- Find unused indexes with `pg_stat_user_indexes.idx_scan` over a full business
  cycle. Keep indexes that enforce constraints.
- An update is HOT (no index maintenance) only when it changes no indexed column
  and the page has free space. Each new index can disable HOT updates.

### Build indexes on live tables

```sql
SET lock_timeout = '5s';
CREATE INDEX CONCURRENTLY idx_orders_customer ON orders (customer_id);
```

- `CONCURRENTLY` does not block writes, but it scans the table twice and waits
  for running transactions.
- It cannot run inside a transaction block. Many migration tools wrap each
  migration in a transaction; disable that for this migration.
- On failure it leaves an `INVALID` index that still costs writes. Drop it and
  retry.
- On a partitioned table, build each partition index concurrently, then create
  the parent index.

Sources: <https://www.postgresql.org/docs/current/sql-createindex.html>,
<https://www.postgresql.org/docs/current/indexes-multicolumn.html>,
<https://www.postgresql.org/docs/current/storage-hot.html>.

## Statistics

- Autovacuum runs `ANALYZE`. Run `ANALYZE t` manually after bulk loads and on
  partitioned parents, which autovacuum does not analyze.
- Raise the target for one skewed column before you raise
  `default_statistics_target` (default 100):
  `ALTER TABLE t ALTER COLUMN c SET STATISTICS 1000;`
- For correlated columns, use extended statistics:

  ```sql
  CREATE STATISTICS orders_city_zip (dependencies, ndistinct, mcv)
    ON city, zip FROM orders;
  ANALYZE orders;
  ```

  Extended statistics do not improve join estimates.

Sources: <https://www.postgresql.org/docs/current/planner-stats.html>,
<https://www.postgresql.org/docs/current/sql-createstatistics.html>.

## Prepared statements

PostgreSQL uses custom plans for the first five executions, then can switch to
a generic plan. If a query becomes slow after several calls with skewed
parameters, compare `EXPLAIN EXECUTE` results and test
`SET plan_cache_mode = force_custom_plan`.

Source: <https://www.postgresql.org/docs/current/sql-prepare.html>.

## Vacuum and bloat

- Updates and deletes leave dead rows. Autovacuum makes the space reusable,
  updates the visibility map, and prevents transaction ID wraparound.
- Plain `VACUUM` does not return space to the OS. `VACUUM FULL` does, but
  rewrites the table under an `ACCESS EXCLUSIVE` lock.
- Long transactions and sessions `idle in transaction` stop vacuum from
  removing dead rows. Find them in `pg_stat_activity` (`xact_start`,
  `backend_xmin`) and set `idle_in_transaction_session_timeout`.
- Check `n_dead_tup`, `last_autovacuum`, and `last_autoanalyze` in
  `pg_stat_user_tables`. Tune autovacuum per table for large, busy tables.

Source: <https://www.postgresql.org/docs/current/routine-vacuuming.html>.

## Locks and migrations

- Most `ALTER TABLE` forms take `ACCESS EXCLUSIVE`, which blocks reads. A DDL
  statement that waits for a lock also blocks every later query on the table.
  Always set a short `lock_timeout` in migrations and retry.
- `ADD COLUMN` with a constant default does not rewrite the table (PostgreSQL
  11+). A volatile default does.
- `SET NOT NULL` scans the table. Add `CHECK (c IS NOT NULL) NOT VALID`, run
  `VALIDATE CONSTRAINT`, then `SET NOT NULL` to skip the scan.
- Add foreign keys with `NOT VALID`, then `VALIDATE CONSTRAINT`.
- Find blockers with `pg_blocking_pids(pid)`.
- `statement_timeout` limits run time. `lock_timeout` limits each lock wait. A
  `lock_timeout` equal to or longer than `statement_timeout` has no effect.

Sources: <https://www.postgresql.org/docs/current/sql-altertable.html>,
<https://www.postgresql.org/docs/current/explicit-locking.html>,
<https://www.postgresql.org/docs/current/runtime-config-client.html>.

## Bulk loads

- Use `COPY`, or multi-row `INSERT` in one transaction.
- For a new table, load the data first, then create indexes and constraints,
  then `ANALYZE`.
- Dropping indexes on an existing table removes their uniqueness enforcement
  during the load.

Source: <https://www.postgresql.org/docs/current/populate.html>.

## Settings

Change settings only after the queries and indexes are right, and measure each
change.

| Setting | Notes |
| --- | --- |
| `shared_buffers` | About 25% of RAM on a dedicated server is the documented starting point. |
| `work_mem` | Per sort or hash node, per session, per parallel worker. A large global value can exhaust memory. Raise it per session or per role for heavy queries. |
| `maintenance_work_mem` | Index builds and vacuum. |
| `effective_cache_size` | A planner estimate. It allocates nothing. |
| `random_page_cost` | Default 4. Lower values (such as 1.1) on SSD favor index scans; benchmark first. |
| `max_connections` | Each connection is a process. Use a pooler instead of a high value. |

PgBouncer in transaction mode breaks session state: `SET`, SQL `PREPARE`,
advisory locks, and `LISTEN`. Protocol-level prepared statements work when
`max_prepared_statements` is set.

Sources: <https://www.postgresql.org/docs/current/runtime-config-resource.html>,
<https://www.postgresql.org/docs/current/runtime-config-query.html>,
<https://www.pgbouncer.org/features.html>.

## Partitioning

Partitioning helps when queries filter on the partition key, so the planner
prunes most partitions, or when you drop old data by detaching partitions. It is
not faster by default. Many partitions increase planning time and memory.

Source: <https://www.postgresql.org/docs/current/ddl-partitioning.html>.
