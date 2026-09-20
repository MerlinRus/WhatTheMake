// Explicit opt-in operational check: one small artificial request, never user data.
import process from 'node:process';
import console from 'node:console';
import {
  createDeepSeekLlmProvider,
  createOpenBeautyFactsProductProvider,
} from '@wtm/infrastructure';
import { normalizeGtin } from '@wtm/domain';

if (!process.env.DEEPSEEK_API_KEY)
  throw new Error('DeepSeek key is not configured');
const llm = createDeepSeekLlmProvider({
  enabled: true,
  apiKey: process.env.DEEPSEEK_API_KEY,
  timeoutMs: 15000,
});
const result = await llm.transform({
  operation: 'CLASSIFY_AND_SUMMARIZE_ALLOWED_TEXT',
  locale: 'ru-RU',
  items: [{ itemId: 'smoke', text: 'Тушь смывается водой.' }],
  allowedLabels: ['REMOVAL'],
});
console.log(
  JSON.stringify({
    provider: result.providerId,
    model: result.modelId,
    outcome: result.kind,
    ...(result.kind === 'FALLBACK' ? { code: result.code } : {}),
  }),
);
if (result.kind !== 'SUCCEEDED') process.exitCode = 1;
const discovery = createOpenBeautyFactsProductProvider();
for (const input of ['3560070791460', '3600523503384', '9999999999994']) {
  const normalized = normalizeGtin(input);
  if (normalized.kind !== 'VALID') throw new Error('Invalid smoke fixture');
  const found = await discovery.discover(normalized.gtin);
  console.log(
    JSON.stringify({
      gtin: input,
      outcome: found.kind,
      ...(found.kind === 'FOUND'
        ? { category: found.category, name: found.productName }
        : {}),
    }),
  );
  if (
    input !== '9999999999994' &&
    (found.kind !== 'FOUND' || found.category !== 'OTHER')
  )
    process.exitCode = 1;
}
