import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Value } from 'typebox/value';

import { PrivateProductForm } from './private-product.js';

import {
  ApiErrorEnvelopeSchema,
  CreateProductObservationInciRevisionResponseSchema,
  ProductObservationInciAnalysisResponseSchema,
  ProductObservationInciWorkspaceResponseSchema,
  type ProductObservationInciAnalysisResponse,
  type ProductObservationInciRevision,
  type ProductObservationInciWorkspaceResponse,
} from '@wtm/contracts';

type Workspace = ProductObservationInciWorkspaceResponse['workspace'];
type Analysis = ProductObservationInciAnalysisResponse['analysis'];

type WorkspaceState =
  | { kind: 'LOADING' }
  | { kind: 'ERROR'; message: string }
  | { kind: 'READY'; workspace: Workspace };

function correctionError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Не удалось обновить текст состава.';
}

async function loadWorkspace(
  observationId: string,
  signal: AbortSignal,
): Promise<Workspace> {
  const response = await fetch(
    `/api/v1/product-observations/${observationId}/inci-revisions`,
    {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    },
  );
  if (!response.ok) throw new Error('Не удалось загрузить текст состава.');
  const payload: unknown = await response.json();
  if (!Value.Check(ProductObservationInciWorkspaceResponseSchema, payload)) {
    throw new Error('Сервис состава вернул некорректный ответ.');
  }
  return payload.workspace;
}

async function loadAnalysis(
  observationId: string,
  revisionId: string,
  signal: AbortSignal,
): Promise<Analysis> {
  const response = await fetch(
    `/api/v1/product-observations/${observationId}/inci-revisions/${revisionId}/analysis`,
    {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    },
  );
  if (!response.ok) throw new Error('Не удалось разобрать выбранную редакцию.');
  const payload: unknown = await response.json();
  if (!Value.Check(ProductObservationInciAnalysisResponseSchema, payload)) {
    throw new Error('Сервис разбора вернул некорректный ответ.');
  }
  return payload.analysis;
}

function sourceLabel(revision: ProductObservationInciRevision): string {
  switch (revision.source.kind) {
    case 'OCR':
      return `OCR · ${revision.source.providerId} ${revision.source.providerVersion}`;
    case 'USER_TRANSCRIPTION':
      return 'Введено вручную';
    case 'USER_CORRECTION':
      return 'Исправлено вручную';
  }
}

function revisionDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function selectableRevisions(
  workspace: Workspace,
  initialRevision?: ProductObservationInciRevision,
): ProductObservationInciRevision[] {
  const revisions = workspace.original ? [workspace.original] : [];
  if (
    workspace.latest &&
    workspace.latest.revisionId !== workspace.original?.revisionId
  ) {
    revisions.push(workspace.latest);
  }
  if (
    initialRevision &&
    !revisions.some(
      (revision) => revision.revisionId === initialRevision.revisionId,
    )
  ) {
    revisions.push(initialRevision);
  }
  return revisions.sort(
    (left, right) => left.revisionNumber - right.revisionNumber,
  );
}

function withRevision(
  workspace: Workspace,
  payload: {
    resultKind: 'CREATED' | 'REUSED';
    revision: ProductObservationInciRevision;
  },
): Workspace {
  return {
    original: workspace.original ?? payload.revision,
    latest: payload.revision,
    revisionCount:
      workspace.revisionCount + (payload.resultKind === 'CREATED' ? 1 : 0),
    maxRevisions: workspace.maxRevisions,
  };
}

const functionLabels: Readonly<Record<string, string>> = {
  SOLVENT: 'Растворитель',
  HUMECTANT: 'Удержание влаги',
  EMOLLIENT: 'Смягчающий компонент',
  FILM_FORMING: 'Плёнкообразователь',
  COLORANT: 'Краситель',
  PRESERVATIVE: 'Консервант',
  VISCOSITY_CONTROLLING: 'Регулятор вязкости',
  EMULSIFYING: 'Эмульгатор',
};

function IngredientDetails({
  details,
}: {
  details: NonNullable<Analysis['details']>;
}) {
  return (
    <div>
      <h4>Что удалось прочитать в составе</h4>
      <p>
        Это разбор выбранного текста, не проверка всей упаковки. Порядок списка
        не определяет концентрации. Функция отдельного ингредиента не доказывает
        эффект, безопасность или переносимость готовой туши.
      </p>
      <p>
        {details.knowledge
          ? `Справочник функций: ${details.knowledge.version}, опубликован ${revisionDate(details.knowledge.publishedAt)}.`
          : 'Опубликованных сведений о функциях пока нет. Ниже — только результат проверки названий; свойства не угаданы.'}
      </p>
      <ol>
        {details.ingredients.map((ingredient) => (
          <li key={`${ingredient.position}-${ingredient.componentPosition}`}>
            <strong>
              {ingredient.identity.kind === 'RESOLVED'
                ? ingredient.identity.ingredient.canonicalName
                : ingredient.sourceText}
            </strong>
            <p>
              В тексте, позиция {ingredient.position + 1}: «
              {ingredient.sourceText}»
              {ingredient.sourceTextTruncated && ' (показан фрагмент)'}.{' '}
              {ingredient.presence === 'MAY_CONTAIN'
                ? 'Может содержать: наличие в этом оттенке не подтверждено.'
                : 'Указан в выбранном тексте.'}
              {ingredient.uncertain && ' Текст требует сверки с упаковкой.'}
            </p>
            {ingredient.identity.kind === 'AMBIGUOUS' && (
              <p>
                Неоднозначное название:{' '}
                {ingredient.identity.candidates
                  .map((candidate) => candidate.canonicalName)
                  .join(', ')}
                .
                {ingredient.identity.omittedCandidateCount > 0 &&
                  ' Есть другие варианты.'}{' '}
                Свойства не присвоены — уточните текст.
              </p>
            )}
            {ingredient.identity.kind === 'UNRESOLVED' && (
              <p>
                Название не сопоставлено. Проверьте OCR и написание на упаковке.
              </p>
            )}
            {ingredient.identity.kind === 'RESOLVED' &&
              ingredient.functions.length === 0 && (
                <p>
                  Подтверждённые сведения о функции пока отсутствуют. Это не
                  означает ни вред, ни безопасность.
                </p>
              )}
            {ingredient.functions.map((fact) => (
              <details key={`${fact.functionCode}-${fact.jurisdiction}`}>
                <summary>
                  {functionLabels[fact.functionCode] ?? fact.functionCode} ·{' '}
                  {fact.jurisdiction}
                  {fact.conflicting && ' · источники противоречат друг другу'}
                </summary>
                <p>
                  Уверенность в справочном факте:{' '}
                  {fact.confidence === 'HIGH'
                    ? 'высокая'
                    : fact.confidence === 'MEDIUM'
                      ? 'средняя'
                      : 'низкая'}
                  . Не оценка готового продукта.
                </p>
                <ul>
                  {fact.evidence.map((evidence, index) => (
                    <li key={`${evidence.sourceUrl}-${index}`}>
                      {evidence.stance === 'CONTRADICTS'
                        ? 'Противоречит'
                        : 'Подтверждает'}
                      :{' '}
                      <a
                        href={evidence.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Источник {index + 1}
                      </a>{' '}
                      · проверен {revisionDate(evidence.checkedAt)}.
                    </li>
                  ))}
                </ul>
                {fact.omittedEvidenceCount > 0 && (
                  <p>Не показано источников: {fact.omittedEvidenceCount}.</p>
                )}
              </details>
            ))}
            {ingredient.omittedFunctionCount > 0 && (
              <p>
                Не показано справочных функций:{' '}
                {ingredient.omittedFunctionCount}.
              </p>
            )}
          </li>
        ))}
      </ol>
      {details.omittedComponentCount > 0 && (
        <p>
          Список сокращён: не показано компонентов{' '}
          {details.omittedComponentCount}. Нельзя считать его полным составом.
        </p>
      )}
    </div>
  );
}

function AnalysisSummary({ analysis }: { analysis: Analysis }) {
  return (
    <div className="inci-analysis">
      <strong role="status">Разбор редакции сохранённого текста</strong>
      {analysis.parse.kind === 'REJECTED' ? (
        <p>Текст превышает безопасный лимит разбора.</p>
      ) : (
        <p>
          Токенов: {analysis.parse.tokenCount}. Требуют проверки:{' '}
          {analysis.parse.uncertainTokenCount}.
        </p>
      )}
      {analysis.details && <IngredientDetails details={analysis.details} />}
      {analysis.normalization.kind === 'NOT_RUN' ? (
        <small>
          {analysis.normalization.reason === 'NO_PUBLISHED_DICTIONARY'
            ? 'Канонический словарь ещё не опубликован. Ничего не угадано.'
            : 'Канонизация не запускалась.'}
        </small>
      ) : (
        <small>
          Сопоставлено: {analysis.normalization.resolvedCount}; неоднозначно:{' '}
          {analysis.normalization.ambiguousCount}; не найдено:{' '}
          {analysis.normalization.unresolvedCount}. Словарь{' '}
          {analysis.normalization.dictionaryVersion}.
        </small>
      )}
    </div>
  );
}

export function InciCorrectionWorkspace({
  observationId,
  mediaAssetId,
  initialRevision,
  onHistoryChange,
}: {
  observationId: string;
  mediaAssetId: string | null;
  initialRevision?: ProductObservationInciRevision;
  onHistoryChange?(): void;
}) {
  const [state, setState] = useState<WorkspaceState>({ kind: 'LOADING' });
  const [draft, setDraft] = useState('');
  const [selectedRevisionId, setSelectedRevisionId] = useState('');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState<'OCR' | 'SAVE' | 'ANALYZE' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const revisions =
    state.kind === 'READY'
      ? selectableRevisions(state.workspace, initialRevision)
      : [];
  const selectedRevision = revisions.find(
    (revision) => revision.revisionId === selectedRevisionId,
  );

  function isCurrent(controller: AbortController): boolean {
    return operation.current === controller && !controller.signal.aborted;
  }

  function finish(controller: AbortController) {
    if (!isCurrent(controller)) return;
    operation.current = null;
    setBusy(null);
  }

  useEffect(() => {
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = null;
    setBusy(null);
    setActionError(null);
    setState({ kind: 'LOADING' });
    setAnalysis(null);
    void loadWorkspace(observationId, controller.signal)
      .then((workspace) => {
        if (controller.signal.aborted) return;
        const initial = initialRevision
          ? selectableRevisions(workspace, initialRevision).find(
              (revision) => revision.revisionId === initialRevision.revisionId,
            )
          : workspace.latest;
        setState({ kind: 'READY', workspace });
        setDraft(initial?.sourceText ?? '');
        setSelectedRevisionId(initial?.revisionId ?? '');
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({ kind: 'ERROR', message: correctionError(error) });
        }
      });
    return () => {
      controller.abort();
      operation.current?.abort();
      operation.current = null;
    };
  }, [observationId, initialRevision]);

  async function recognize() {
    if (
      state.kind !== 'READY' ||
      mediaAssetId === null ||
      operation.current !== null
    ) {
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    setBusy('OCR');
    setAnalysis(null);
    setActionError(null);
    try {
      const response = await fetch(
        `/api/v1/product-observations/${observationId}/inci-ocr`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ mediaAssetId }),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(40_000),
          ]),
        },
      );
      if (!response.ok) {
        const problem: unknown = await response.json().catch(() => null);
        const details = Value.Check(ApiErrorEnvelopeSchema, problem)
          ? problem.error.details
          : null;
        const reason =
          typeof details === 'object' && details !== null && 'reason' in details
            ? details.reason
            : null;
        if (reason === 'OCR_BUDGET_EXHAUSTED') {
          throw new Error(
            'Суточный лимит распознавания исчерпан. Введите состав вручную или попробуйте после 03:00 по Москве.',
          );
        }
        throw new Error(
          response.status === 422
            ? 'На фото не найден читаемый текст состава.'
            : response.status === 429
              ? 'Сервис распознавания занят. Попробуйте немного позже.'
              : 'Не удалось распознать состав. Введите его вручную или попробуйте позже.',
        );
      }
      const payload: unknown = await response.json();
      if (!isCurrent(controller)) return;
      if (
        !Value.Check(
          CreateProductObservationInciRevisionResponseSchema,
          payload,
        )
      ) {
        throw new Error('Сервис распознавания вернул некорректный ответ.');
      }
      setState({
        kind: 'READY',
        workspace: withRevision(state.workspace, payload),
      });
      setDraft(payload.revision.sourceText);
      setSelectedRevisionId(payload.revision.revisionId);
      const result = await loadAnalysis(
        observationId,
        payload.revision.revisionId,
        controller.signal,
      );
      if (isCurrent(controller)) setAnalysis(result);
    } catch (error) {
      if (isCurrent(controller)) setActionError(correctionError(error));
    } finally {
      finish(controller);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== 'READY' || operation.current !== null) return;
    const controller = new AbortController();
    operation.current = controller;
    const base = selectedRevision;
    setBusy('SAVE');
    setAnalysis(null);
    setActionError(null);
    try {
      const response = await fetch(
        `/api/v1/product-observations/${observationId}/inci-revisions`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(
            base
              ? {
                  kind: 'USER_CORRECTION',
                  basedOnRevisionId: base.revisionId,
                  sourceText: draft,
                }
              : { kind: 'USER_TRANSCRIPTION', sourceText: draft },
          ),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(20_000),
          ]),
        },
      );
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? 'Такое исправление нельзя сохранить повторно.'
            : 'Не удалось сохранить редакцию состава.',
        );
      }
      const payload: unknown = await response.json();
      if (!isCurrent(controller)) return;
      if (
        !Value.Check(
          CreateProductObservationInciRevisionResponseSchema,
          payload,
        )
      ) {
        throw new Error('Сервис исправлений вернул некорректный ответ.');
      }
      const nextWorkspace = withRevision(state.workspace, payload);
      setState({ kind: 'READY', workspace: nextWorkspace });
      setDraft(payload.revision.sourceText);
      setSelectedRevisionId(payload.revision.revisionId);
      const result = await loadAnalysis(
        observationId,
        payload.revision.revisionId,
        controller.signal,
      );
      if (isCurrent(controller)) setAnalysis(result);
    } catch (error) {
      if (isCurrent(controller)) setActionError(correctionError(error));
    } finally {
      finish(controller);
    }
  }

  async function analyzeSelected() {
    if (
      state.kind !== 'READY' ||
      !selectedRevision ||
      operation.current !== null
    )
      return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy('ANALYZE');
    setAnalysis(null);
    setActionError(null);
    try {
      const result = await loadAnalysis(
        observationId,
        selectedRevisionId,
        controller.signal,
      );
      if (isCurrent(controller)) setAnalysis(result);
    } catch (error) {
      if (isCurrent(controller)) setActionError(correctionError(error));
    } finally {
      finish(controller);
    }
  }

  return (
    <section className="inci-correction-card" aria-labelledby="inci-title">
      <header>
        <div>
          <span className="eyebrow">Проверка состава</span>
          <h3 id="inci-title">Текст INCI</h3>
        </div>
        <span>Оригинал неизменяем</span>
      </header>

      {state.kind === 'LOADING' && <p role="status">Загружаем текст…</p>}
      {state.kind === 'ERROR' && <p role="alert">{state.message}</p>}
      {state.kind === 'READY' && (
        <>
          {state.workspace.original ? (
            <div className="inci-source-evidence">
              <div>
                <strong>Исходная редакция</strong>
                <span>{sourceLabel(state.workspace.original)}</span>
                <time dateTime={state.workspace.original.createdAt}>
                  {revisionDate(state.workspace.original.createdAt)}
                </time>
              </div>
              <pre>{state.workspace.original.sourceText}</pre>
            </div>
          ) : (
            <div className="inci-ocr-action">
              <p>
                {mediaAssetId
                  ? 'Фото состава готово. Распознавание запускается только по вашему нажатию.'
                  : 'Сначала добавьте чёткое фото состава INCI выше.'}
              </p>
              {mediaAssetId && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void recognize()}
                >
                  {busy === 'OCR' ? 'Распознаём…' : 'Распознать состав с фото'}
                </button>
              )}
              <small>
                Результат сохранится как неизменяемый оригинал. Его можно
                исправить отдельной редакцией.
              </small>
            </div>
          )}

          <form onSubmit={(event) => void save(event)}>
            <label htmlFor="inci-source-text">
              {state.workspace.original
                ? 'Исправленный текст состава'
                : 'Исходный текст состава'}
            </label>
            <textarea
              id="inci-source-text"
              value={draft}
              maxLength={100_000}
              rows={7}
              disabled={busy !== null}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div>
              <small>
                Редакций: {state.workspace.revisionCount} из{' '}
                {state.workspace.maxRevisions}
              </small>
              <button
                type="submit"
                disabled={
                  busy !== null ||
                  draft.trim().length === 0 ||
                  draft === selectedRevision?.sourceText ||
                  state.workspace.revisionCount >= state.workspace.maxRevisions
                }
              >
                {busy === 'SAVE'
                  ? 'Сохраняем…'
                  : state.workspace.original
                    ? 'Сохранить исправление и разобрать'
                    : 'Сохранить и разобрать'}
              </button>
            </div>
          </form>

          {revisions.length > 0 && (
            <div className="inci-reanalysis">
              <label htmlFor="inci-revision-select">Редакция для разбора</label>
              <select
                id="inci-revision-select"
                value={selectedRevisionId}
                disabled={busy !== null}
                onChange={(event) => {
                  const selected = revisions.find(
                    (revision) => revision.revisionId === event.target.value,
                  );
                  if (!selected) return;
                  operation.current?.abort();
                  operation.current = null;
                  setBusy(null);
                  setSelectedRevisionId(selected.revisionId);
                  setDraft(selected.sourceText);
                  setAnalysis(null);
                  setActionError(null);
                }}
              >
                {revisions.map((revision) => (
                  <option key={revision.revisionId} value={revision.revisionId}>
                    Редакция {revision.revisionNumber} · {sourceLabel(revision)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy !== null || selectedRevisionId === ''}
                onClick={() => void analyzeSelected()}
              >
                {busy === 'ANALYZE'
                  ? 'Разбираем…'
                  : 'Разобрать выбранную редакцию'}
              </button>
            </div>
          )}
          {analysis && <AnalysisSummary analysis={analysis} />}
          {selectedRevisionId !== '' && (
            <PrivateProductForm
              onSaved={() => onHistoryChange?.()}
              key={`${observationId}:${selectedRevisionId}`}
              observationId={observationId}
              revisionId={selectedRevisionId}
            />
          )}
          {actionError && (
            <p className="inci-correction-error" role="alert">
              {actionError}
            </p>
          )}
        </>
      )}
    </section>
  );
}
