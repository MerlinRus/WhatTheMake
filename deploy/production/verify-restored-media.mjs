import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import console from 'node:console';
import { Pool } from 'pg';

// Only used in an isolated restore container; credentials are non-production.
const pool = new Pool({
  connectionString:
    'postgresql://wtm_restore:restore-test-only@127.0.0.1:5432/wtm_restore',
});
try {
  const { rows } = await pool.query(
    'SELECT id, byte_size, sha256 FROM wtm_media_assets WHERE deleted_at IS NULL',
  );
  for (const asset of rows) {
    if (!/^[a-f0-9-]{36}$/.test(asset.id))
      throw new Error('Invalid restored media identity');
    const bytes = await readFile(
      join(
        '/restore/media',
        asset.id.slice(0, 2),
        asset.id.slice(2, 4),
        asset.id,
      ),
    );
    if (
      bytes.length !== asset.byte_size ||
      createHash('sha256').update(bytes).digest('hex') !== asset.sha256.trim()
    )
      throw new Error('Restored media checksum mismatch');
  }
  const { rows: tables } = await pool.query(
    "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'wtm_%'",
  );
  if (tables[0].count < 10) throw new Error('Restored schema is incomplete');
  console.log(
    JSON.stringify({
      restore: 'VERIFIED',
      tables: tables[0].count,
      activeMedia: rows.length,
    }),
  );
} finally {
  await pool.end();
}
