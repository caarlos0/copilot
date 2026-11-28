# SQLite

Use with `SKILL.md`. Check the SQLite version first with
`SELECT sqlite_version();`. Many features below depend on it.

## Read the plan

```sql
EXPLAIN QUERY PLAN SELECT ...;
```

In the CLI, `.eqp on` shows the plan for each statement and `.timer on` shows
timing. `EXPLAIN QUERY PLAN` does not run the query and gives no actual row
counts. Its output format is not a stable API.

| Plan text | Meaning |
| --- | --- |
| `SCAN t` | Reads every row of the table |
| `SCAN t USING INDEX i` | Reads every entry of the index |
| `SEARCH t USING INDEX i (a=?)` | Seeks into the index; reads a subset |
| `USING COVERING INDEX i` | Does not read the table |
| `USE TEMP B-TREE FOR ORDER BY` | Sorts in a temporary structure; an index could remove it |
| `AUTOMATIC INDEX` | Builds a temporary index for this statement; a permanent index can help |

The CLI command `.expert` followed by a query proposes indexes. It is
experimental. Measure each proposal against representative data and write cost.

Sources: <https://www.sqlite.org/eqp.html>,
<https://www.sqlite.org/cli.html#index_recommendations_sqlite_expert_>,
<https://www.sqlite.org/optoverview.html#autoindex>.

## Indexes

- A composite index uses a leftmost prefix: equality, `IN`, or `IS` columns,
  then one range column. Skip-scan is an exception that needs statistics.
- Partial indexes (3.8.0+) apply only when SQLite can prove that the query
  implies the index predicate. Use the same literal form in the query.
- Expression indexes (3.9.0+) apply only when the query uses the same
  expression. `x+y` does not match `y+x`. Functions must be deterministic.
- `INTEGER PRIMARY KEY` is an alias of the rowid, which is the fastest lookup.
  `INT PRIMARY KEY` is not an alias.
- `WITHOUT ROWID` (3.8.2+) can help small rows with composite or text primary
  keys. It is slower for large rows and does not support `AUTOINCREMENT`.
- `LIKE 'abc%'` uses an index only when the pattern does not start with a
  wildcard and the column collation matches: `NOCASE` for the default
  case-insensitive `LIKE`. Do not use the deprecated `case_sensitive_like`.
- A function or cast on an indexed column prevents a seek on a plain index.
- `OR` can use several indexes or become `IN`. A scan can still be cheaper.
- A comparison with a different type affinity can prevent index use. Bind values
  with the column type.

Sources: <https://www.sqlite.org/optoverview.html>,
<https://www.sqlite.org/partialindex.html>, <https://www.sqlite.org/expridx.html>,
<https://www.sqlite.org/withoutrowid.html>.

## Statistics

`ANALYZE` fills `sqlite_stat1` (and `sqlite_stat4` in builds with STAT4). The
planner uses these to choose indexes.

For SQLite 3.46.0 and later:

- Short-lived connections: run `PRAGMA optimize;` before close.
- Long-lived connections: run `PRAGMA optimize=0x10002;` on open, then
  `PRAGMA optimize;` periodically.
- Run `PRAGMA optimize;` after schema changes such as `CREATE INDEX`.

Source: <https://www.sqlite.org/lang_analyze.html#recommended_usage_patterns>.

## Transactions and concurrency

- Batch writes in one transaction. Each commit syncs to disk.
- Prepare a statement once, then bind, step, and reset it for each row.
  `sqlite3_reset` keeps bindings; rebind every value.
- SQLite allows one writer at a time. Start write transactions with
  `BEGIN IMMEDIATE`. A deferred transaction that reads and then writes can fail
  with `SQLITE_BUSY` when it tries to upgrade, and the busy timeout does not
  help in that case.
- Set `PRAGMA busy_timeout` on each connection. Keep write transactions short.
- In application code, use one write connection, or a pool with one writer and
  many readers.

Sources: <https://www.sqlite.org/lang_transaction.html>,
<https://www.sqlite.org/c3ref/busy_handler.html>,
<https://www.sqlite.org/rescode.html#busy_snapshot>.

## WAL mode

```sql
PRAGMA journal_mode = WAL;   -- check that it returns 'wal'
PRAGMA synchronous = NORMAL;
```

- WAL lets readers run while one writer writes. It does not allow two writers.
- WAL needs shared memory on one host. Do not use it on network filesystems.
- With `synchronous=NORMAL` in WAL, the database stays consistent, but the last
  committed transactions can be lost on power loss or OS crash. Use `FULL`
  when every commit must be durable.
- Checkpoints copy WAL pages into the database. The default automatic threshold
  is 1000 pages (`wal_autocheckpoint`). A long-running reader blocks checkpoint
  completion and makes the WAL file grow.
- SQLite 3.7.0 to 3.51.2 have a rare WAL-reset corruption race. It is fixed in
  3.51.3, 3.50.7, and 3.44.6.

Sources: <https://www.sqlite.org/wal.html>,
<https://www.sqlite.org/pragma.html#pragma_synchronous>.

## PRAGMAs

Most PRAGMAs apply per connection. Set them each time you open a connection.

| PRAGMA | Notes |
| --- | --- |
| `foreign_keys = ON` | Off by default. Set outside a transaction. |
| `cache_size = -N` | About N KiB of page cache per database. |
| `mmap_size = N` | Maximum bytes of memory-mapped I/O. |
| `temp_store = MEMORY` | Temporary tables and indexes in memory. |
| `page_size = N` | Set before you create the database, or change with `VACUUM` in rollback-journal mode, not WAL. |

Do not copy a PRAGMA block without a measurement. `synchronous=OFF` and
`journal_mode=OFF` or `MEMORY` risk corruption on a crash.

Source: <https://www.sqlite.org/pragma.html>.

## Space

- Deleted rows leave free pages. The file does not shrink.
- `VACUUM` rebuilds the file. It needs up to twice the file size in free space,
  holds an exclusive lock, and can change rowids that are not
  `INTEGER PRIMARY KEY`.
- `auto_vacuum=INCREMENTAL` with `PRAGMA incremental_vacuum` returns free pages
  without a full rebuild. Changing `auto_vacuum` on an existing database needs a
  `VACUUM`.

Source: <https://www.sqlite.org/lang_vacuum.html>.

## Other notes

- N+1 queries are often acceptable: there is no network round trip. The work of
  each query still counts.
  Source: <https://www.sqlite.org/np1queryprob.html>.
- `STRICT` tables (3.37.0+) enforce column types. They are a correctness
  feature, not a performance feature.
- Row values for keyset pagination need 3.15.0+.
