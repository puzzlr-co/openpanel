import fs from 'node:fs';
import path from 'node:path';
import {
  addColumns,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

// Hot `properties` Map keys read on the overview cold path. A Map lookup
// decompresses the entire map per row (~6x slower than a native column), so we
// extract them into MATERIALIZED columns and repoint the overview queries.
// Definitions mirror the exact expressions the queries use today, so results
// are byte-identical to the Map path (correctness preserved).
const MATERIALIZED_COLUMNS = ['game_id', 'days_since_first_visit'] as const;

/**
 * Backfills the MATERIALIZED columns on pre-existing parts. Async background
 * mutation (CH default) — no table lock; un-rewritten parts compute the column
 * on read until the mutation finishes, so correctness holds throughout. Inline
 * here (not in shared migration.ts) to keep the upstream-merge surface at zero.
 *
 * Both columns are materialized in a SINGLE ALTER so they share one mutation /
 * one part-rewrite pass (half the I/O of two separate MATERIALIZE statements).
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
      [
        "`game_id` LowCardinality(String) MATERIALIZED properties['game_id']",
        "`days_since_first_visit` UInt32 MATERIALIZED toUInt32OrZero(properties['days_since_first_visit'])",
      ],
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
