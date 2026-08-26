import type { OcrProvider, OcrRequest, OcrResult } from '@wtm/domain';

export interface FakeOcrProvider extends OcrProvider {
  readonly requests: readonly OcrRequest[];
}

export function createFakeOcrProvider(
  respond: (
    request: OcrRequest,
    requestIndex: number,
  ) => OcrResult | Promise<OcrResult>,
): FakeOcrProvider {
  const requests: OcrRequest[] = [];

  return {
    providerId: 'FAKE',
    version: 'test-v1',
    requests,
    async recognize(request): Promise<OcrResult> {
      const requestIndex = requests.push(request) - 1;
      return respond(request, requestIndex);
    },
  };
}
