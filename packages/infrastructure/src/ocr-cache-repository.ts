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
          WHERE cache_key = $1
        `,
        [cacheKey],
      );
      return result.rows[0]?.result_text ?? null;
    },

    async put(cacheKey, text): Promise<void> {
      await pool.query(
        `
          INSERT INTO wtm_ocr_provider_cache (cache_key, result_text)
          VALUES ($1, $2)
          ON CONFLICT (cache_key) DO NOTHING
        `,
        [cacheKey, text],
      );
    },
  };
}
