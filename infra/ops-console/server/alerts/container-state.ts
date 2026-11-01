/** Чистая логика состояния контейнеров — без БД, покрыта тестами. */

export { isContainerDown, isExpectedExit } from '../../shared/container-state'

const STATEFUL_PATTERNS = [
  'postgres',
  'pgbouncer',
  'redis',
  'minio',
  'clickhouse',
  'kafka',
  'zookeeper',
  'mysql',
  'mariadb',
  'mongo',
  'elasticsearch',
  'opensearch',
  'rabbitmq',
  'vault',
  'etcd',
]

/**
 * Хранит ли контейнер данные. Явная метка агента (`ops.stateful`) приоритетнее эвристики по
 * имени, сервису compose и образу. Ошибка в сторону «stateful» безопасна: перезапуск просто
 * потребует ввести имя.
 */
export function isStateful(c: { name: string; image: string; composeService: string; stateful?: boolean }): boolean {
  if (typeof c.stateful === 'boolean') return c.stateful
  const hay = `${c.name} ${c.composeService} ${c.image}`.toLowerCase()
  return STATEFUL_PATTERNS.some((p) => hay.includes(p))
}

/** Прирост счётчика перезапусков демона за окно: база — последнее значение до окна, иначе минимум в окне. */
export function restartDelta(current: number, baselineBeforeWindow: number | null, minInWindow: number | null): number {
  const base = baselineBeforeWindow ?? minInWindow
  if (base === null) return 0
  // Счётчик сбрасывается при пересоздании контейнера — отрицательный прирост означает «с нуля».
  return current >= base ? current - base : current
}
