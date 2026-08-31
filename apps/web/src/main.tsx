import {
  lazy,
  StrictMode,
  Suspense,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { createRoot } from 'react-dom/client';
import { Value } from 'typebox/value';

import {
  CatalogVariantResponseSchema,
  ProductDiscoveryResponseSchema,
  type CatalogSource,
  type CatalogVariantResponse,
  type ExternalProductCandidate,
} from '@wtm/contracts';

import './styles.css';
import { ProductObservationCapture } from './product-observation.js';
import { ProductComparison } from './comparison.js';

interface ScannerShellProps {
  onClose(): void;
  onDetected(value: string): void;
}

function ScannerLoadError({ onClose }: ScannerShellProps) {
  return (
    <div className="scanner-loading" role="alert">
      <div>
        <strong>Сканер не загрузился</strong>
        <p>Проверьте соединение или введите штрихкод вручную.</p>
        <button type="button" onClick={onClose}>
          Вернуться к ручному вводу
        </button>
      </div>
    </div>
  );
}

const BarcodeScanner = lazy(async () => {
  try {
    return await import('./barcode-scanner.js');
  } catch {
    return { default: ScannerLoadError };
  }
});

type Variant = CatalogVariantResponse['variant'];
type LookupState =
  | { kind: 'IDLE' }
  | { kind: 'LOADING' }
  | { kind: 'DISCOVERING'; gtin: string }
  | { kind: 'FOUND'; variant: Variant }
  | { kind: 'EXTERNAL'; candidate: ExternalProductCandidate }
  | { kind: 'NOT_FOUND'; gtin: string }
  | { kind: 'DISCOVERY_UNAVAILABLE'; gtin: string }
  | { kind: 'OBSERVING'; gtin: string }
  | { kind: 'INVALID' }
  | { kind: 'UNAVAILABLE' };

const claimLabels: Record<Variant['claims'][number]['kind'], string> = {
  VOLUME: 'Объём',
  LENGTH: 'Удлинение',
  SEPARATION: 'Разделение',
  NATURAL_LOOK: 'Естественный эффект',
  WATERPROOF: 'Водостойкость',
  EASY_REMOVAL: 'Лёгкое снятие',
  OTHER: 'Заявление производителя',
};

function formatQuantity(variant: Variant): string | null {
  if (variant.netQuantity === null) return null;
  const value = Number(variant.netQuantity.value).toLocaleString('ru-RU', {
    maximumFractionDigits: 4,
  });
  return `${value} ${variant.netQuantity.unit === 'MILLILITER' ? 'мл' : 'г'}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(value));
}

function SourceLine({
  label,
  source,
}: {
  label: string;
  source: CatalogSource;
}) {
  const date = formatDate(source.observedAt ?? source.importedAt);
  return (
    <li>
      <span>{label}</span>
      {source.sourceUrl === null ? (
        <strong>{source.sourceLabel}</strong>
      ) : (
        <a href={source.sourceUrl} target="_blank" rel="noreferrer">
          {source.sourceLabel}
        </a>
      )}
      <small>{date}</small>
    </li>
  );
}

function ProductCard({
  variant,
  onCompare,
}: {
  variant: Variant;
  onCompare(): void;
}) {
  const quantity = formatQuantity(variant);
  const waterproof =
    variant.isWaterproof === null
      ? 'Водостойкость не указана'
      : variant.isWaterproof
        ? 'Водостойкая'
        : 'Обычная';

  return (
    <article className="product-card" aria-labelledby="product-title">
      <div className="exact-badge">
        <span aria-hidden="true">✓</span>
        Точный вариант по GTIN
      </div>

      <header className="product-heading">
        <p>{variant.brandName}</p>
        <h2 id="product-title">{variant.familyName}</h2>
        <span>{variant.variantName}</span>
      </header>

      <div className="facts" aria-label="Признаки варианта">
        {variant.shadeName !== null && (
          <span>Оттенок: {variant.shadeName}</span>
        )}
        {quantity !== null && <span>{quantity}</span>}
        <span>{waterproof}</span>
      </div>

      {variant.claims.length > 0 && (
        <section className="card-section" aria-labelledby="claims-title">
          <p className="eyebrow" id="claims-title">
            Claims производителя
          </p>
          <div className="claims-grid">
            {variant.claims.map((claim) => (
              <div className="claim" key={claim.productClaimId}>
                <strong>{claimLabels[claim.kind]}</strong>
                <span>{claim.text}</span>
                <small>Источник: {claim.source.sourceLabel}</small>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card-section">
        <details>
          <summary>
            <span>
              <span className="eyebrow">Состав</span>
              <strong>
                {variant.formula === null
                  ? 'INCI пока не подтверждён'
                  : `INCI · ревизия ${variant.formula.revisionNumber}`}
              </strong>
            </span>
            <span aria-hidden="true">+</span>
          </summary>
          {variant.formula !== null && (
            <div className="detail-body">
              <p className="inci">{variant.formula.inciText}</p>
              <p>Источник: {variant.formula.source.sourceLabel}</p>
            </div>
          )}
        </details>
      </section>

      <section className="card-section">
        <details>
          <summary>
            <span>
              <span className="eyebrow">Проверяемость</span>
              <strong>Источники карточки</strong>
            </span>
            <span aria-hidden="true">+</span>
          </summary>
          <ul className="source-list detail-body">
            <SourceLine
              label="Линейка"
              source={variant.identitySources.family}
            />
            <SourceLine
              label="Вариант"
              source={variant.identitySources.variant}
            />
            <SourceLine
              label="Штрихкод"
              source={variant.identitySources.barcode}
            />
          </ul>
        </details>
      </section>

      <div className="card-action">
        <button type="button" onClick={onCompare}>
          Сравнить с другим
        </button>
        <small>Два или три точных GTIN · без универсального score</small>
      </div>
    </article>
  );
}

function StatusPanel({
  state,
  onObserve,
  onCompare,
}: {
  state: LookupState;
  onObserve(gtin: string): void;
  onCompare(variant: Variant): void;
}) {
  if (state.kind === 'IDLE') return null;
  if (state.kind === 'LOADING') {
    return (
      <div className="status-panel loading" role="status">
        <span aria-hidden="true" /> Ищем точный вариант…
      </div>
    );
  }
  if (state.kind === 'DISCOVERING') {
    return (
      <div className="status-panel loading" role="status">
        <span aria-hidden="true" /> Ищем GTIN в открытом каталоге…
      </div>
    );
  }
  if (state.kind === 'FOUND')
    return (
      <ProductCard
        variant={state.variant}
        onCompare={() => onCompare(state.variant)}
      />
    );
  if (state.kind === 'EXTERNAL') {
    return (
      <article className="status-panel external-card">
        <div className="external-badge">
          Open Beauty Facts · данные не проверены
        </div>
        <h2>{state.candidate.productName}</h2>
        <p>
          {state.candidate.brandName ?? 'Бренд не указан'}
          {state.candidate.quantity === null
            ? ''
            : ` · ${state.candidate.quantity}`}
        </p>
        <p>
          Карточка найдена автоматически, но ещё не подтверждена в What The
          Make.
        </p>
        <div>
          <a href={state.candidate.productUrl} target="_blank" rel="noreferrer">
            Открыть источник
          </a>
          <button type="button" onClick={() => onObserve(state.candidate.gtin)}>
            Подтвердить по фото
          </button>
        </div>
      </article>
    );
  }
  if (state.kind === 'OBSERVING') {
    return <ProductObservationCapture gtin={state.gtin} />;
  }

  const content = {
    NOT_FOUND: {
      title: 'Товара пока нет в каталоге',
      text: 'Создайте личную карточку: фото названия, состава, claims, штрихкода и ценника.',
    },
    INVALID: {
      title: 'Штрихкод не прошёл проверку',
      text: 'Нужны 8, 12, 13 или 14 цифр с верной контрольной цифрой.',
    },
    UNAVAILABLE: {
      title: 'Каталог временно недоступен',
      text: 'Попробуйте ещё раз через несколько секунд.',
    },
    DISCOVERY_UNAVAILABLE: {
      title: 'Внешний поиск временно недоступен',
      text: 'В нашей базе товара нет. Можно добавить его по фото или повторить поиск позже.',
    },
  }[state.kind];

  return (
    <div className="status-panel empty" role="status">
      <span className="empty-mark" aria-hidden="true">
        ?
      </span>
      <div>
        <h2>{content.title}</h2>
        <p>{content.text}</p>
        {(state.kind === 'NOT_FOUND' ||
          state.kind === 'DISCOVERY_UNAVAILABLE') && (
          <button
            className="start-observation"
            type="button"
            onClick={() => onObserve(state.gtin)}
          >
            Добавить по фото
          </button>
        )}
      </div>
    </div>
  );
}

function App() {
  const [gtin, setGtin] = useState('');
  const [state, setState] = useState<LookupState>({ kind: 'IDLE' });
  const [scannerOpen, setScannerOpen] = useState(false);
  const [comparisonVariant, setComparisonVariant] = useState<Variant | null>(
    null,
  );
  const scanButtonRef = useRef<HTMLButtonElement>(null);
  const scanReceiverRef = useRef<((value: string) => void) | null>(null);
  const scannerReturnFocusRef = useRef<HTMLElement | null>(null);
  const comparisonReturnFocusRef = useRef<HTMLElement | null>(null);
  const lookupGeneration = useRef(0);

  async function lookup(value: string) {
    const generation = ++lookupGeneration.current;
    let catalogMiss = false;
    if (![8, 12, 13, 14].includes(value.length)) {
      setState({ kind: 'INVALID' });
      return;
    }

    setState({ kind: 'LOADING' });
    try {
      const response = await fetch(`/api/v1/catalog/barcodes/${value}`, {
        headers: { Accept: 'application/json' },
      });
      if (response.status === 404) {
        catalogMiss = true;
        setState({ kind: 'DISCOVERING', gtin: value });
        const discoveryResponse = await fetch(
          `/api/v1/discovery/barcodes/${value}`,
          {
            headers: { Accept: 'application/json' },
          },
        );
        if (!discoveryResponse.ok)
          throw new Error(`Discovery returned ${discoveryResponse.status}`);
        const discoveryPayload: unknown = await discoveryResponse.json();
        if (!Value.Check(ProductDiscoveryResponseSchema, discoveryPayload)) {
          throw new Error('Discovery returned an invalid response');
        }
        if (generation !== lookupGeneration.current) return;
        if (discoveryPayload.discovery.state === 'FOUND') {
          setState({
            kind: 'EXTERNAL',
            candidate: discoveryPayload.discovery.candidate,
          });
        } else if (discoveryPayload.discovery.state === 'NOT_FOUND') {
          setState({ kind: 'NOT_FOUND', gtin: value });
        } else {
          setState({ kind: 'DISCOVERY_UNAVAILABLE', gtin: value });
        }
        return;
      }
      if (response.status === 400) {
        setState({ kind: 'INVALID' });
        return;
      }
      if (!response.ok) throw new Error(`Catalog returned ${response.status}`);

      const payload: unknown = await response.json();
      if (!Value.Check(CatalogVariantResponseSchema, payload)) {
        throw new Error('Catalog returned an invalid response');
      }
      if (generation === lookupGeneration.current)
        setState({ kind: 'FOUND', variant: payload.variant });
    } catch {
      if (generation === lookupGeneration.current) {
        setState(
          catalogMiss
            ? { kind: 'DISCOVERY_UNAVAILABLE', gtin: value }
            : { kind: 'UNAVAILABLE' },
        );
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void lookup(gtin);
  }

  function closeScanner() {
    setScannerOpen(false);
    scanReceiverRef.current = null;
    requestAnimationFrame(() => scannerReturnFocusRef.current?.focus());
  }

  function useDetectedBarcode(value: string) {
    const receiver = scanReceiverRef.current;
    scanReceiverRef.current = null;
    setScannerOpen(false);
    requestAnimationFrame(() => scannerReturnFocusRef.current?.focus());
    if (receiver !== null) {
      receiver(value);
    } else {
      setGtin(value);
      void lookup(value);
    }
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="What The Make — главная">
          <img src="/what-the-make-logo.png" alt="" width="2172" height="724" />
        </a>
        <span>BETA · MASCARA</span>
      </header>

      <main>
        <section className="hero" aria-labelledby="page-title">
          <p className="eyebrow">Проверка у полки</p>
          <h1 id="page-title">Что именно у вас в руках?</h1>
          <p className="lead">
            Введите цифры под штрихкодом. Найдём точный вариант, не смешивая
            оттенки, объём и формулу.
          </p>

          <form className="lookup-form" onSubmit={submit}>
            <label htmlFor="gtin">GTIN / EAN</label>
            <div>
              <input
                id="gtin"
                name="gtin"
                inputMode="numeric"
                autoComplete="off"
                placeholder="Например, 13 цифр"
                value={gtin}
                maxLength={14}
                onChange={(event) =>
                  setGtin(
                    event.target.value.replace(/[^0-9]/g, '').slice(0, 14),
                  )
                }
                aria-describedby="gtin-hint"
              />
              <button type="submit" disabled={state.kind === 'LOADING'}>
                Найти
              </button>
            </div>
            <small id="gtin-hint">8, 12, 13 или 14 цифр</small>
            <button
              ref={scanButtonRef}
              className="scan-button"
              type="button"
              onClick={() => {
                scanReceiverRef.current = null;
                scannerReturnFocusRef.current = scanButtonRef.current;
                setScannerOpen(true);
              }}
            >
              <span aria-hidden="true" />
              Сканировать камерой
            </button>
            <small className="local-camera-note">
              Камера работает локально. Ручной ввод всегда доступен.
            </small>
          </form>
        </section>

        <div className="result" aria-live="polite">
          <StatusPanel
            state={state}
            onObserve={(value) => setState({ kind: 'OBSERVING', gtin: value })}
            onCompare={(variant) => {
              comparisonReturnFocusRef.current =
                document.activeElement instanceof HTMLElement
                  ? document.activeElement
                  : null;
              setComparisonVariant(variant);
            }}
          />
        </div>
      </main>

      {comparisonVariant !== null && (
        <ProductComparison
          initialVariant={comparisonVariant}
          onClose={() => {
            setComparisonVariant(null);
            requestAnimationFrame(() =>
              comparisonReturnFocusRef.current?.focus(),
            );
          }}
          onScan={(receiver) => {
            scanReceiverRef.current = receiver;
            scannerReturnFocusRef.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
            setScannerOpen(true);
          }}
        />
      )}

      <footer>
        <p>Состав и claims объясняются осторожно. Без медицинских выводов.</p>
      </footer>

      {scannerOpen && (
        <Suspense
          fallback={
            <div className="scanner-loading" role="status">
              <div>
                <strong>Загружаем локальный сканер…</strong>
                <button type="button" onClick={closeScanner}>
                  Отмена
                </button>
              </div>
            </div>
          }
        >
          <BarcodeScanner
            onClose={closeScanner}
            onDetected={useDetectedBarcode}
          />
        </Suspense>
      )}
    </div>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('Root element is missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
