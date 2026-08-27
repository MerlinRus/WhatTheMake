import type {
  LlmProvider,
  LlmOutcome,
  LlmResult,
  LlmTextTransformRequest,
} from '@wtm/domain';

export interface FakeLlmProvider extends LlmProvider {
  readonly requests: readonly LlmTextTransformRequest[];
}

export function createFakeLlmProvider(
  respond: (
    request: LlmTextTransformRequest,
    requestIndex: number,
  ) => LlmOutcome | Promise<LlmOutcome>,
): FakeLlmProvider {
  const requests: LlmTextTransformRequest[] = [];
  const providerId = 'FAKE';
  const modelId = 'fake-model';
  const promptVersion = 'test-prompt-v1';

  return {
    providerId,
    modelId,
    promptVersion,
    requests,
    async transform(request): Promise<LlmResult> {
      const requestIndex = requests.push(request) - 1;
      return {
        providerId,
        modelId,
        promptVersion,
        ...(await respond(request, requestIndex)),
      };
    },
  };
}
