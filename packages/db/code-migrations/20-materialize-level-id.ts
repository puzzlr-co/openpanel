import fs from 'node:fs';
import path from 'node:path';
import {
  addColumns,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

// level_id is the dedup key of the canonical puzzle completion rate: the metric
// counts distinct (game, session_id, level_id) pairs finished over pairs opened,
// so every load of the client-shared overview reads it. Same rationale as
// migrations 18/19 — reading it from the `properties` Map decompresses the whole
// map per row (measured on prod: properties is 802 MiB compressed / 11.14 GiB
// uncompressed, vs 56 MiB / 145 MiB for this column) — and it lands on the
// cold-load path that already saturates the 8-core box. Measured 4.5x on the
// metric's own query: uniqExact((session_id, level_id)) over 30d of level_started
// went 1.996s -> 0.446s, same result.
//
// LowCardinality despite ~12k distinct values globally: the dictionary is built
// per part and `events` partitions by toYYYYMM(created_at), so it is bounded by
// one month's distinct level_ids (peak 8,728 in 202606) against ~25M rows in that
// part — a distinct/rows ratio of 0.0003. Cardinality scales with games x
// levels-per-month, not with time, so it never accumulates across months.
//
// Cost, measured on prod rather than argued: the largest partition (202606) holds
// this column in 22.08 MiB compressed, ~1.6x game_id's 14.06 MiB in the same
// partition — dearer than game_id (~30 distinct), as the cardinality implies, but
// trivial next to the 802 MiB properties read it removes from the hot path.
//
// The definition mirrors the Map expression exactly, so results are
// byte-identical to the Map path (verified on prod across all 80.98M rows:
// countIf(level_id != properties['level_id']) = 0).
const MATERIALIZED_COLUMNS = ['level_id'] as const;

/**
 * Backfills the MATERIALIZED column on pre-existing parts. Async background
 * mutation (CH default) — no table lock; un-rewritten parts compute the column
 * on read until the mutation finishes, so correctness holds throughout. Inline
 * here (not in shared migration.ts) to keep the upstream-merge surface at zero.
 */
function materializeColumns(
  tableName: string,
  columnNames: readonly string[],
  isClustered: boolean,
): string[] {
  // MATERIALIZE targets the local replicated table that holds data, not the
  // Distributed proxy.
  const target = isClustered
    ? `${tableName}_replicated ON CLUSTER '{cluster}'`
    : tableName;

  const actions = columnNames
    .map((col) => `MATERIALIZE COLUMN ${col}`)
    .join(', ');

  return [`ALTER TABLE ${target} ${actions}`];
}

export async function up() {
  const isClustered = getIsCluster();

  const sqls: string[] = [
    ...addColumns(
      'events',
      ["`level_id` LowCardinality(String) MATERIALIZED properties['level_id']"],
      isClustered,
    ),
    ...materializeColumns('events', MATERIALIZED_COLUMNS, isClustered),
  ];

  fs.writeFileSync(
    path.join(import.meta.filename.replace('.ts', '.sql')),
    sqls
      .map((sql) =>
        sql
          .trim()
          .replace(/;$/, '')
          .replace(/\n{2,}/g, '\n')
          .concat(';'),
      )
      .join('\n\n---\n\n'),
  );

  if (!process.argv.includes('--dry')) {
    await runClickhouseMigrationCommands(sqls);
  }
}
