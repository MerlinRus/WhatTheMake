import { useId } from 'react';
import type { CustomerReviewMentions as Mentions } from '@wtm/contracts';

const labels: Record<Mentions['topics'][number]['topic'], string> = {
  VOLUME: 'Объём',
  LENGTH: 'Длина',
  CLUMPING: 'Комочки и склеивание',
  FLAKING: 'Осыпание',
  REMOVAL: 'Смывание',
  WATERPROOF: 'Водостойкость',
};

export function CustomerReviewMentions({
  mentions,
  anchorPrefix,
}: {
  mentions: Mentions | undefined;
  anchorPrefix: string;
}) {
  const id = useId();
  if (!mentions) return null;
  return (
    <section aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>Темы в отзывах</h4>
      <p>
        Это упоминания в показанных отзывах, не оценка свойства. Считаем
        фиксированные слова, в том числе с отрицанием; положительный или
        отрицательный опыт не определяем. Темы не влияют на рекомендацию.
      </p>
      <p>
        Источник: {mentions.source}. Выборка: {mentions.sampleSize}{' '}
        опубликованных отзывов этого варианта. Данные на{' '}
        <time dateTime={mentions.asOf}>
          {new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' }).format(
            new Date(mentions.asOf),
          )}
        </time>
        .
      </p>
      <ul>
        {mentions.topics.map((item) => (
          <li key={item.topic}>
            {labels[item.topic]} — упоминаний в отзывах:{' '}
            {item.matchedReviewCount} из {mentions.sampleSize}.{' '}
            {item.reviewIds.map((reviewId, index) => (
              <span key={reviewId}>
                {index > 0 ? ', ' : ''}
                <a
                  href={`#${anchorPrefix}${reviewId}`}
                  aria-label={`${labels[item.topic]}: перейти к отзыву ${index + 1}`}
                >
                  Отзыв {index + 1}
                </a>
              </span>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
