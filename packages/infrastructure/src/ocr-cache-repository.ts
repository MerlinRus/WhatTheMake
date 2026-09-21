import type { Pool } from 'pg';

import type { OcrCacheStore } from './cached-ocr-provider.js';

interface CacheRow {
  result_text: string;
}

export function createPostgresOcrCacheStore(pool: Pool): OcrCacheStore {
  return {
    async get(cacheKey): Promise<string | null> {
      const result = await pool.query<CacheRow>(
        `
          SELECT result_text
          FROM wtm_ocr_provider_cache
          WHERE cache_key = $1 AND expires_at > now()
        `,
        [cacheKey],
      );
      return result.rows[0]?.result_text ?? null;
    },

    async put(cacheKey, text): Promise<void> {
      await pool.query(
        `
          INSERT INTO wtm_ocr_provider_cache (cache_key, result_text, created_at, expires_at)
          VALUES ($1, $2, now(), now() + interval '7 days')
          ON CONFLICT (cache_key) DO UPDATE
          SET result_text = EXCLUDED.result_text,
              created_at = EXCLUDED.created_at,
              expires_at = EXCLUDED.expires_at
          WHERE wtm_ocr_provider_cache.expires_at <= now()
        `,
        [cacheKey, text],
      );
      // Lock only this bounded batch; concurrent writes must not lose a refreshed row.
      await pool.query(`
        WITH expired AS (
          SELECT cache_key FROM wtm_ocr_provider_cache
          WHERE expires_at <= now()
          ORDER BY expires_at, cache_key
          LIMIT 100 FOR UPDATE SKIP LOCKED
        )
        DELETE FROM wtm_ocr_provider_cache AS cache
        USING expired
        WHERE cache.cache_key = expired.cache_key AND cache.expires_at <= now()
      `);
    },
  };
}
