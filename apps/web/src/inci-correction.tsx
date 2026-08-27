import { useEffect, useState, type FormEvent } from 'react';
import { Value } from 'typebox/value';

import {
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
    { headers: { Accept: 'application/json' }, signal },
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
): Promise<Analysis> {
  const response = await fetch(
    `/api/v1/product-observations/${observationId}/inci-revisions/${revisionId}/analysis`,
    { headers: { Accept: 'application/json' } },
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
): ProductObservationInciRevision[] {
  const revisions = workspace.original ? [workspace.original] : [];
  if (
    workspace.latest &&
    workspace.latest.revisionId !== workspace.original?.revisionId
  ) {
    revisions.push(workspace.latest);
  }
  return revisions;
}

function AnalysisSummary({ analysis }: { analysis: Analysis }) {
  return (
    <div className="inci-analysis" role="status">
      <strong>Разбор редакции сохранённого текста</strong>
      {analysis.parse.kind === 'REJECTED' ? (
        <p>Текст превышает безопасный лимит разбора.</p>
      ) : (
        <p>
          Токенов: {analysis.parse.tokenCount}. Требуют проверки:{' '}
          {analysis.parse.uncertainTokenCount}.
        </p>
      )}
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
}: {
  observationId: string;
}) {
  const [state, setState] = useState<WorkspaceState>({ kind: 'LOADING' });
  const [draft, setDraft] = useState('');
  const [selectedRevisionId, setSelectedRevisionId] = useState('');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState<'SAVE' | 'ANALYZE' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'LOADING' });
    void loadWorkspace(observationId, controller.signal)
      .then((workspace) => {
        setState({ kind: 'READY', workspace });
        setDraft(workspace.latest?.sourceText ?? '');
        setSelectedRevisionId(workspace.latest?.revisionId ?? '');
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({ kind: 'ERROR', message: correctionError(error) });
        }
      });
    return () => controller.abort();
  }, [observationId]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== 'READY') return;
    const base = state.workspace.latest;
    setBusy('SAVE');
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
      if (
        !Value.Check(
          CreateProductObservationInciRevisionResponseSchema,
          payload,
        )
      ) {
        throw new Error('Сервис исправлений вернул некорректный ответ.');
      }
      const nextWorkspace: Workspace = {
        original: state.workspace.original ?? payload.revision,
        latest: payload.revision,
        revisionCount:
          state.workspace.revisionCount +
          (payload.resultKind === 'CREATED' ? 1 : 0),
        maxRevisions: state.workspace.maxRevisions,
      };
      setState({ kind: 'READY', workspace: nextWorkspace });
      setDraft(payload.revision.sourceText);
      setSelectedRevisionId(payload.revision.revisionId);
      setAnalysis(
        await loadAnalysis(observationId, payload.revision.revisionId),
      );
    } catch (error) {
      setActionError(correctionError(error));
    } finally {
      setBusy(null);
    }
  }

  async function analyzeSelected() {
    if (selectedRevisionId === '') return;
    setBusy('ANALYZE');
    setActionError(null);
    try {
      setAnalysis(await loadAnalysis(observationId, selectedRevisionId));
    } catch (error) {
      setActionError(correctionError(error));
    } finally {
      setBusy(null);
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
            <p className="inci-empty-source">
              OCR ещё не настроен. Перепишите состав с упаковки — этот текст
              станет неизменяемым оригиналом.
            </p>
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
                  draft === state.workspace.latest?.sourceText ||
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

          {state.workspace.latest && (
            <div className="inci-reanalysis">
              <label htmlFor="inci-revision-select">Редакция для разбора</label>
              <select
                id="inci-revision-select"
                value={selectedRevisionId}
                disabled={busy !== null}
                onChange={(event) => setSelectedRevisionId(event.target.value)}
              >
                {selectableRevisions(state.workspace).map((revision) => (
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
