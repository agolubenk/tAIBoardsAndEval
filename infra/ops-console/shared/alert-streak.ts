/**
 * Правила бизнес-метрик (biz_*) считают замеры, а не отчёты: агент меряет раз в BUSINESS_INTERVAL_SEC и повторяет
 * значение в каждом отчёте, консоль оценивает правило только на новом замере (server/agents/ingest.ts).
 */
import { plural } from './plural'

/** «, 2 замера подряд» — хвост условия правила по бизнес-метрике; один замер — пусто. */
export function bizStreakText(forSamples: number): string {
  return forSamples > 1 ? `, ${plural(forSamples, ['замер', 'замера', 'замеров'])} подряд` : ''
}
