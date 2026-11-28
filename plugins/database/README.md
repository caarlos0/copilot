# database

A skill for SQL performance: query plans, indexes, schema, transactions, and
migrations. It has engine references for SQLite and PostgreSQL.

## Install

```sh
copilot plugin marketplace add caarlos0/copilot
copilot plugin install database@caarlos0
```

## Agents

This plugin has no agents.

## Skills

| Skill | Use it to |
| --- | --- |
| `sql` | Find and fix slow queries, design indexes, and change schemas safely |

The `sql` skill loads one reference for the engine in use:

| File | Engine |
| --- | --- |
| `skills/sql/sqlite.md` | SQLite: `EXPLAIN QUERY PLAN`, WAL, PRAGMAs, `ANALYZE`, `VACUUM` |
| `skills/sql/postgresql.md` | PostgreSQL: `EXPLAIN ANALYZE`, index types, statistics, vacuum, locks, settings |
