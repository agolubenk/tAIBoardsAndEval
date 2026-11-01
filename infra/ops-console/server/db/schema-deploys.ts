/**
 * Схема: живой ход деплоя (часть server/db/schema.ts) — карточка на каждый прогон contabo-deploy.sh,
 * собранная из его событий (shared/deploy-events-contract.ts). Запуски GitHub Actions — таблица deploys,
 * карточка находит свой запуск по sha при чтении.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { now, ts } from './columns'

export const deployProgress = sqliteTable(
  'deploy_progress',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agentId: text('agent_id').notNull(),
    /** `<sha>-<unix старта>`: повтор деплоя того же коммита — новая карточка. */
    deployId: text('deploy_id').notNull(),
    sha: text('sha').notNull(),
    status: text('status', { enum: ['running', 'success', 'failed'] }).notNull(),
    /** Код выхода contabo-deploy.sh (из deploy_done). */
    rc: integer('rc'),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at'),
    /** Сводка события с наибольшим seq (фазы, проверки, rollback-prev), JSON по deploySummarySchema. */
    summaryJson: text('summary_json').notNull(),
    /** Принятые события `[{seq,type,at}]`: по пропускам видно, какие потерялись. */
    eventsJson: text('events_json').notNull().default('[]'),
    lastSeq: integer('last_seq').notNull(),
    /** X-Ops-Timestamp последнего принятого события (мс): повтор подписанного запроса отклоняется. */
    lastEventTs: integer('last_event_ts').notNull(),
    /** Когда консоль приняла последнее событие: по нему — «событий давно нет». */
    lastEventAt: ts('last_event_at').notNull(),
    createdAt: ts('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('idx_deploy_progress_key').on(t.agentId, t.deployId),
    index('idx_deploy_progress_started').on(t.startedAt),
    index('idx_deploy_progress_agent_created').on(t.agentId, t.createdAt),
  ],
)
