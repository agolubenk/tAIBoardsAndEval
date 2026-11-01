/**
 * Колонка «Связь» на /deploys: пункты очереди владельца, связанные с деплоем, — по одному в строку. Сервер отдаёт их
 * только роли owner (server/deploys/queue-links.ts). /queue — отдельная страница, не маршрут SPA, поэтому обычная ссылка.
 */
import type { DeployQueueLinks } from '../../lib/types'
import s from './deploys.module.css'

const KIND_LABEL: Record<string, string> = { merge: 'Мёрж', decision: 'Решение', check: 'Проверка', server: 'Сервер', inbox: 'Входящее' }

/** Пункт на странице очереди: она прокрутит к нему и покажет, даже если он выполнен (page.html, targetFromHash). */
export function queueItemHref(id: string): string {
  return `/queue#item=${encodeURIComponent(id)}`
}

export function QueueLinks({ queue }: { queue: DeployQueueLinks }) {
  return (
    <ul className={s.qLinks}>
      {queue.links.map((l) => (
        <li key={l.id}>
          <a href={queueItemHref(l.id)} className={l.done ? `${s.qLink} ${s.qIsDone}` : s.qLink} title={l.title}>
            <span className={s.qKind}>{KIND_LABEL[l.kind] ?? l.kind}</span>
            {l.done ? (
              <>
                {/* aria-label на span без роли читалки пропускают — текст для них отдельно. */}
                <span className={s.qDone} aria-hidden="true">
                  ✓
                </span>
                <span className="visually-hidden">выполнено</span>
              </>
            ) : null}
            <span className={s.qTitle}>{l.title}</span>
          </a>
        </li>
      ))}
      {queue.more > 0 ? <li className={s.qMore}>и ещё {queue.more}</li> : null}
    </ul>
  )
}
