import type { InciDictionarySnapshot } from './inci-canonicalization.js';
import { assessIngredientExclusions } from './ingredient-exclusions.js';

export type ComparisonReasonCode =
  | 'INSUFFICIENT_READY_SLOTS'
  | 'EXTERNAL_IDENTITY_UNCONFIRMED'
  | 'DUPLICATE_VARIANT'
  | 'REVIEW_DATA_UNAVAILABLE'
  | 'EVIDENCE_TOO_CLOSE'
  | 'CONFLICTING_CRITERIA'
  | 'HARD_CONSTRAINT_DATA_MISSING'
  | 'HARD_CONSTRAINT_VIOLATED'
  | 'EASY_REMOVAL_MATCH'
  | 'CONTEXT_NOT_ASSESSED'
  | 'NO_SUPPORTED_DIFFERENCE'
  | 'EXACT_CATALOG_IDENTITY'
  | 'USER_CONFIRMED_IDENTITY'
  | 'USER_FORMULA_AVAILABLE'
  | 'USER_PRICE_AVAILABLE'
  | 'WATERPROOF_MATCH'
  | 'WATERPROOF_CONFLICT'
  | 'AVOIDED_INGREDIENT_PRESENT'
  | 'AVOIDED_INGREDIENT_ABSENT'
  | 'GOAL_CLAIM_MATCH'
  | 'GOAL_CLAIM_NOT_FOUND'
  | 'REVIEW_EVIDENCE_COMPARED'
  | 'FORMULA_AVAILABLE'
  | 'FORMULA_DATA_UNAVAILABLE'
  | 'PRICE_DATA_UNAVAILABLE';

export type ComparisonConfidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type ComparisonOutcome =
  'ADVANTAGE' | 'DISADVANTAGE' | 'NEUTRAL' | 'NO_DATA';
export type ComparisonCriterionKind =
  | 'IDENTITY_AND_DATA'
  | 'HARD_CONSTRAINTS'
  | 'DESIRED_EFFECT'
  | 'CUSTOMER_REVIEWS'
  | 'FORMULA_AND_CLAIMS'
  | 'PRICE_AND_VALUE';
export type ComparisonClaimKind =
  | 'VOLUME'
  | 'LENGTH'
  | 'SEPARATION'
  | 'NATURAL_LOOK'
  | 'WATERPROOF'
  | 'EASY_REMOVAL'
  | 'OTHER';

export interface ComparisonReviewSignal {
  ratingValue: number;
  reviewCount: number;
  asOf: Date;
  sourceQuality: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface ReadyComparisonCandidate {
  state: 'READY';
  slotIndex: number;
  gtin: string;
  productVariantId: string;
  isWaterproof: boolean | null;
  formulaText: string | null;
  claimKinds: readonly ComparisonClaimKind[];
  review: ComparisonReviewSignal | null;
  identitySource?: 'CATALOG' | 'USER_CONFIRMED_PACKAGING';
  formulaComplete?: boolean;
  priceKopecks?: number | null;
}

export interface BlockedComparisonCandidate {
  state: 'BLOCKED';
  slotIndex: number;
  gtin: string;
  reason:
    | 'NOT_FOUND'
    | 'INVALID_GTIN'
    | 'EXTERNAL_CANDIDATE'
    | 'DUPLICATE_VARIANT'
    | 'SOURCE_UNAVAILABLE'
    | 'UNSUPPORTED_CATEGORY';
}

export type ComparisonCandidate =
  ReadyComparisonCandidate | BlockedComparisonCandidate;

export type ComparisonBrief =
  | {
      mode: 'UNKNOWN_GOALS';
      waterproof: 'REQUIRED' | 'AVOID' | 'NO_PREFERENCE';
      removal: 'EASY_REQUIRED' | 'NO_PREFERENCE';
      avoidedIngredients: readonly string[];
      sensitiveEyes?: boolean;
      contactLenses?: boolean;
    }
  | {
      mode: 'PERSONALIZED';
      goals: readonly ('VOLUME' | 'LENGTH' | 'SEPARATION' | 'NATURAL_LOOK')[];
      waterproof: 'REQUIRED' | 'AVOID' | 'NO_PREFERENCE';
      removal: 'EASY_REQUIRED' | 'NO_PREFERENCE';
      avoidedIngredients: readonly string[];
      sensitiveEyes?: boolean;
      contactLenses?: boolean;
    };

export interface DomainCriterionObservation {
  slotIndex: number;
  productVariantId: string | null;
  outcome: ComparisonOutcome;
  confidence: ComparisonConfidence;
  reasonCode: ComparisonReasonCode;
  evidence: readonly string[];
}

export interface DomainComparisonResult {
  recommendation:
    | {
        kind: 'PREFERRED';
        productVariantId: string;
        confidence: ComparisonConfidence;
        reasonCodes: readonly ComparisonReasonCode[];
      }
    | {
        kind: 'NO_CLEAR_WINNER';
        confidence: 'LOW' | 'MEDIUM';
        reasonCodes: readonly ComparisonReasonCode[];
      };
  criteria: ReadonlyArray<{
    kind: ComparisonCriterionKind;
    observations: readonly DomainCriterionObservation[];
  }>;
}

interface HardEvidence {
  outcome: ComparisonOutcome;
  confidence: ComparisonConfidence;
  reasonCode: ComparisonReasonCode;
  evidence: string[];
  violations: number;
  matches: number;
  missing: boolean;
}

function hardEvidence(
  candidate: ReadyComparisonCandidate,
  brief: ComparisonBrief,
  dictionary: InciDictionarySnapshot | null,
): HardEvidence {
  const evidence: string[] = [];
  let violations = 0;
  let matches = 0;
  let missing = false;
  let reasonCode: ComparisonReasonCode = 'NO_SUPPORTED_DIFFERENCE';

  if (brief.waterproof !== 'NO_PREFERENCE') {
    if (candidate.isWaterproof === null) {
      missing = true;
    } else {
      const matchesPreference =
        brief.waterproof === 'REQUIRED'
          ? candidate.isWaterproof
          : !candidate.isWaterproof;
      if (matchesPreference) {
        matches += 1;
        reasonCode = 'WATERPROOF_MATCH';
        evidence.push('Водостойкость соответствует выбранному ограничению');
      } else {
        violations += 1;
        reasonCode = 'WATERPROOF_CONFLICT';
        evidence.push('Водостойкость противоречит выбранному ограничению');
      }
    }
  }

  if (brief.avoidedIngredients.length > 0) {
    const checked = assessIngredientExclusions(
      candidate.formulaText,
      brief.avoidedIngredients,
      dictionary,
    );
    missing ||= checked.uncertain || candidate.formulaComplete === false;
    if (checked.present.length > 0) {
      violations += checked.present.length;
      reasonCode = 'AVOIDED_INGREDIENT_PRESENT';
      evidence.push(`В составе найдены исключения (${checked.present.length})`);
    } else if (!checked.uncertain && candidate.formulaComplete !== false) {
      matches += 1;
      if (violations === 0) reasonCode = 'AVOIDED_INGREDIENT_ABSENT';
      evidence.push('Исключения не найдены в сопоставленном составе');
    }
  }

  if (brief.removal === 'EASY_REQUIRED') {
    if (candidate.claimKinds.includes('EASY_REMOVAL')) {
      matches += 1;
      if (violations === 0) reasonCode = 'EASY_REMOVAL_MATCH';
      evidence.push('В данных упаковки указано лёгкое снятие');
    } else missing = true;
  }
  if (brief.sensitiveEyes || brief.contactLenses) {
    evidence.push(
      'Подходящесть для чувствительных глаз и контактных линз не установлена',
    );
    if (matches === 0 && violations === 0) reasonCode = 'CONTEXT_NOT_ASSESSED';
  }

  if (violations > 0) {
    return {
      outcome: 'DISADVANTAGE',
      confidence:
        candidate.identitySource === 'USER_CONFIRMED_PACKAGING'
          ? 'MEDIUM'
          : 'HIGH',
      reasonCode,
      evidence,
      violations,
      matches,
      missing,
    };
  }
  if (missing) {
    return {
      outcome: 'NO_DATA',
      confidence: 'LOW',
      reasonCode: 'HARD_CONSTRAINT_DATA_MISSING',
      evidence,
      violations,
      matches,
      missing,
    };
  }
  return {
    outcome: matches > 0 ? 'ADVANTAGE' : 'NEUTRAL',
    confidence:
      matches > 0
        ? candidate.identitySource === 'USER_CONFIRMED_PACKAGING'
          ? 'MEDIUM'
          : 'HIGH'
        : 'LOW',
    reasonCode,
    evidence,
    violations,
    matches,
    missing,
  };
}

function reviewConfidence(
  signal: ComparisonReviewSignal | null,
  now: Date,
): ComparisonConfidence | null {
  if (
    signal === null ||
    !Number.isInteger(signal.reviewCount) ||
    signal.reviewCount < 1 ||
    !Number.isFinite(signal.ratingValue) ||
    signal.ratingValue < 1 ||
    signal.ratingValue > 5
  ) {
    return null;
  }
  const ageMs = now.getTime() - signal.asOf.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 730 * 86_400_000) {
    return null;
  }
  if (effectiveReviewCount(signal, now) < 20) return null;
  return effectiveReviewCount(signal, now) >= 100 &&
    signal.sourceQuality === 'HIGH'
    ? 'HIGH'
    : 'MEDIUM';
}

function effectiveReviewCount(
  signal: ComparisonReviewSignal,
  now: Date,
): number {
  const qualityWeight = { LOW: 0.2, MEDIUM: 0.6, HIGH: 1 }[
    signal.sourceQuality
  ];
  const ageWeight =
    now.getTime() - signal.asOf.getTime() > 365 * 86_400_000 ? 0.5 : 1;
  return signal.reviewCount * qualityWeight * ageWeight;
}

/** Product policy, not a statistical confidence interval: shrink small/weak samples. */
function adjustedReviewRating(
  signal: ComparisonReviewSignal | null,
  now: Date,
): number {
  if (!signal) return 0;
  const count = effectiveReviewCount(signal, now);
  return (signal.ratingValue * count + 3.5 * 20) / (count + 20);
}

function observation(
  candidate: ComparisonCandidate,
  values: Omit<DomainCriterionObservation, 'slotIndex' | 'productVariantId'>,
): DomainCriterionObservation {
  return {
    slotIndex: candidate.slotIndex,
    productVariantId:
      candidate.state === 'READY' ? candidate.productVariantId : null,
    ...values,
  };
}

export function compareMascaras(input: {
  candidates: readonly ComparisonCandidate[];
  brief: ComparisonBrief;
  now: Date;
  dictionary?: InciDictionarySnapshot | null;
}): DomainComparisonResult {
  const ready = input.candidates.filter(
    (candidate): candidate is ReadyComparisonCandidate =>
      candidate.state === 'READY',
  );
  const hardBySlot = new Map(
    ready.map((candidate) => [
      candidate.slotIndex,
      hardEvidence(candidate, input.brief, input.dictionary ?? null),
    ]),
  );
  const goalMatches = new Map(
    ready.map((candidate) => [
      candidate.slotIndex,
      (input.brief.mode === 'PERSONALIZED'
        ? input.brief.goals.filter((goal) =>
            candidate.claimKinds.includes(goal),
          ).length
        : 0) +
        (input.brief.removal === 'EASY_REQUIRED' &&
        candidate.claimKinds.includes('EASY_REMOVAL')
          ? 1
          : 0),
    ]),
  );
  const reviewConfidenceBySlot = new Map(
    ready.map((candidate) => [
      candidate.slotIndex,
      reviewConfidence(candidate.review, input.now),
    ]),
  );
  const reviewable = ready.filter(
    (candidate) => reviewConfidenceBySlot.get(candidate.slotIndex) !== null,
  );
  const orderedReviews = [...reviewable].sort(
    (left, right) =>
      adjustedReviewRating(right.review, input.now) -
      adjustedReviewRating(left.review, input.now),
  );
  const reviewWinner = orderedReviews[0];
  const reviewRunnerUp = orderedReviews[1];
  const reviewHasClearDifference =
    reviewable.length === ready.length &&
    reviewWinner !== undefined &&
    reviewRunnerUp !== undefined &&
    adjustedReviewRating(reviewWinner.review, input.now) -
      adjustedReviewRating(reviewRunnerUp.review, input.now) >=
      0.25;

  const criteria: DomainComparisonResult['criteria'] = [
    {
      kind: 'IDENTITY_AND_DATA',
      observations: input.candidates.map((candidate) =>
        observation(candidate, {
          outcome: candidate.state === 'READY' ? 'NEUTRAL' : 'NO_DATA',
          confidence:
            candidate.state === 'READY'
              ? candidate.identitySource === 'USER_CONFIRMED_PACKAGING'
                ? 'MEDIUM'
                : 'HIGH'
              : 'LOW',
          reasonCode:
            candidate.state === 'READY'
              ? candidate.identitySource === 'USER_CONFIRMED_PACKAGING'
                ? 'USER_CONFIRMED_IDENTITY'
                : 'EXACT_CATALOG_IDENTITY'
              : candidate.reason === 'EXTERNAL_CANDIDATE'
                ? 'EXTERNAL_IDENTITY_UNCONFIRMED'
                : 'INSUFFICIENT_READY_SLOTS',
          evidence:
            candidate.state === 'READY'
              ? [
                  candidate.identitySource === 'USER_CONFIRMED_PACKAGING'
                    ? 'Личная карточка: данные упаковки подтверждены пользователем, не каталогом'
                    : 'Точный опубликованный вариант по GTIN',
                ]
              : [],
        }),
      ),
    },
    {
      kind: 'HARD_CONSTRAINTS',
      observations: input.candidates.map((candidate) => {
        const hard = hardBySlot.get(candidate.slotIndex);
        return observation(candidate, {
          outcome: hard?.outcome ?? 'NO_DATA',
          confidence: hard?.confidence ?? 'LOW',
          reasonCode: hard?.reasonCode ?? 'HARD_CONSTRAINT_DATA_MISSING',
          evidence: hard?.evidence ?? [],
        });
      }),
    },
    {
      kind: 'DESIRED_EFFECT',
      observations: input.candidates.map((candidate) => {
        const matches = goalMatches.get(candidate.slotIndex);
        return observation(candidate, {
          outcome:
            input.brief.mode !== 'PERSONALIZED' || matches === undefined
              ? 'NO_DATA'
              : matches > 0
                ? 'ADVANTAGE'
                : 'NEUTRAL',
          confidence: matches && matches > 0 ? 'MEDIUM' : 'LOW',
          reasonCode:
            matches && matches > 0
              ? 'GOAL_CLAIM_MATCH'
              : 'GOAL_CLAIM_NOT_FOUND',
          evidence:
            matches && matches > 0
              ? [`Совпадений с указанными заявлениями упаковки: ${matches}`]
              : [],
        });
      }),
    },
    {
      kind: 'CUSTOMER_REVIEWS',
      observations: input.candidates.map((candidate) => {
        const confidence = reviewConfidenceBySlot.get(candidate.slotIndex);
        const isReviewWinner =
          reviewHasClearDifference &&
          candidate.state === 'READY' &&
          candidate.productVariantId === reviewWinner?.productVariantId;
        return observation(candidate, {
          outcome:
            confidence === undefined || confidence === null
              ? 'NO_DATA'
              : reviewHasClearDifference
                ? isReviewWinner
                  ? 'ADVANTAGE'
                  : 'DISADVANTAGE'
                : 'NEUTRAL',
          confidence: confidence ?? 'LOW',
          reasonCode:
            confidence === undefined || confidence === null
              ? 'REVIEW_DATA_UNAVAILABLE'
              : 'REVIEW_EVIDENCE_COMPARED',
          evidence:
            candidate.state === 'READY' &&
            confidence !== null &&
            confidence !== undefined
              ? [
                  `Рейтинг ${candidate.review?.ratingValue.toFixed(1)} · отзывов ${candidate.review?.reviewCount}`,
                ]
              : [],
        });
      }),
    },
    {
      kind: 'FORMULA_AND_CLAIMS',
      observations: input.candidates.map((candidate) =>
        observation(candidate, {
          outcome:
            candidate.state === 'READY' && candidate.formulaText !== null
              ? 'NEUTRAL'
              : 'NO_DATA',
          confidence:
            candidate.state === 'READY' && candidate.formulaText !== null
              ? candidate.identitySource === 'USER_CONFIRMED_PACKAGING'
                ? 'MEDIUM'
                : 'HIGH'
              : 'LOW',
          reasonCode:
            candidate.state === 'READY' && candidate.formulaText !== null
              ? candidate.identitySource === 'USER_CONFIRMED_PACKAGING'
                ? 'USER_FORMULA_AVAILABLE'
                : 'FORMULA_AVAILABLE'
              : 'FORMULA_DATA_UNAVAILABLE',
          evidence:
            candidate.state === 'READY' && candidate.formulaComplete === false
              ? [
                  'Полнота состава не подтверждена; отсутствие ингредиента не установлено',
                ]
              : [],
        }),
      ),
    },
    {
      kind: 'PRICE_AND_VALUE',
      observations: input.candidates.map((candidate) =>
        observation(candidate, {
          outcome:
            candidate.state === 'READY' && candidate.priceKopecks != null
              ? 'NEUTRAL'
              : 'NO_DATA',
          confidence:
            candidate.state === 'READY' && candidate.priceKopecks != null
              ? 'MEDIUM'
              : 'LOW',
          reasonCode:
            candidate.state === 'READY' && candidate.priceKopecks != null
              ? 'USER_PRICE_AVAILABLE'
              : 'PRICE_DATA_UNAVAILABLE',
          evidence:
            candidate.state === 'READY' && candidate.priceKopecks != null
              ? [
                  'Цена пользователя: ' +
                    (candidate.priceKopecks / 100).toFixed(2) +
                    ' ₽ за упаковку; сама по себе не доказывает качество',
                ]
              : [],
        }),
      ),
    },
  ];

  const external = input.candidates.some(
    (candidate) =>
      candidate.state === 'BLOCKED' &&
      candidate.reason === 'EXTERNAL_CANDIDATE',
  );
  const duplicate = input.candidates.some(
    (candidate) =>
      candidate.state === 'BLOCKED' && candidate.reason === 'DUPLICATE_VARIANT',
  );
  if (
    ready.length < 2 ||
    ready.length !== input.candidates.length ||
    external ||
    duplicate
  ) {
    return {
      recommendation: {
        kind: 'NO_CLEAR_WINNER',
        confidence: 'LOW',
        reasonCodes: [
          ...(external ? (['EXTERNAL_IDENTITY_UNCONFIRMED'] as const) : []),
          ...(duplicate ? (['DUPLICATE_VARIANT'] as const) : []),
          ...(ready.length < 2 || ready.length !== input.candidates.length
            ? (['INSUFFICIENT_READY_SLOTS'] as const)
            : []),
        ],
      },
      criteria,
    };
  }

  const hard = ready.map((candidate) => ({
    candidate,
    evidence: hardBySlot.get(candidate.slotIndex)!,
  }));
  if (
    hard.some(({ evidence }) => evidence.violations === 0 && evidence.missing)
  ) {
    return {
      recommendation: {
        kind: 'NO_CLEAR_WINNER',
        confidence: 'LOW',
        reasonCodes: ['HARD_CONSTRAINT_DATA_MISSING'],
      },
      criteria,
    };
  }
  const eligible = hard.filter(
    ({ evidence }) => evidence.violations === 0 && !evidence.missing,
  );
  if (eligible.length === 0) {
    return {
      recommendation: {
        kind: 'NO_CLEAR_WINNER',
        confidence: 'MEDIUM',
        reasonCodes: ['HARD_CONSTRAINT_VIOLATED'],
      },
      criteria,
    };
  }
  const hardWinner = eligible[0];
  if (eligible.length === 1 && hardWinner) {
    return {
      recommendation: {
        kind: 'PREFERRED',
        productVariantId: hardWinner.candidate.productVariantId,
        confidence:
          hardWinner.candidate.identitySource === 'USER_CONFIRMED_PACKAGING' ||
          hardWinner.evidence.reasonCode === 'EASY_REMOVAL_MATCH'
            ? 'MEDIUM'
            : 'HIGH',
        reasonCodes: [hardWinner.evidence.reasonCode],
      },
      criteria,
    };
  }

  if (input.brief.mode === 'PERSONALIZED') {
    const ordered = eligible
      .map(({ candidate }) => candidate)
      .sort(
        (left, right) =>
          (goalMatches.get(right.slotIndex) ?? 0) -
          (goalMatches.get(left.slotIndex) ?? 0),
      );
    const winner = ordered[0];
    const runnerUp = ordered[1];
    if (
      winner &&
      runnerUp &&
      (goalMatches.get(winner.slotIndex) ?? 0) >
        (goalMatches.get(runnerUp.slotIndex) ?? 0)
    ) {
      return {
        recommendation: {
          kind: 'PREFERRED',
          productVariantId: winner.productVariantId,
          confidence: 'MEDIUM',
          reasonCodes: ['GOAL_CLAIM_MATCH'],
        },
        criteria,
      };
    }
  }

  const eligibleIds = new Set(
    eligible.map(({ candidate }) => candidate.productVariantId),
  );
  const eligibleReviews = orderedReviews.filter((candidate) =>
    eligibleIds.has(candidate.productVariantId),
  );
  if (eligibleReviews.length === eligible.length) {
    const winner = eligibleReviews[0];
    const runnerUp = eligibleReviews[1];
    if (
      winner &&
      runnerUp &&
      adjustedReviewRating(winner.review, input.now) -
        adjustedReviewRating(runnerUp.review, input.now) >=
        0.25
    ) {
      return {
        recommendation: {
          kind: 'PREFERRED',
          productVariantId: winner.productVariantId,
          confidence: reviewConfidenceBySlot.get(winner.slotIndex) ?? 'MEDIUM',
          reasonCodes: ['REVIEW_EVIDENCE_COMPARED'],
        },
        criteria,
      };
    }
    return {
      recommendation: {
        kind: 'NO_CLEAR_WINNER',
        confidence: 'MEDIUM',
        reasonCodes: ['EVIDENCE_TOO_CLOSE'],
      },
      criteria,
    };
  }

  return {
    recommendation: {
      kind: 'NO_CLEAR_WINNER',
      confidence: 'LOW',
      reasonCodes: [
        input.brief.mode === 'UNKNOWN_GOALS'
          ? 'REVIEW_DATA_UNAVAILABLE'
          : 'NO_SUPPORTED_DIFFERENCE',
      ],
    },
    criteria,
  };
}
