/** Остановлен ли контейнер «по делу» — одно правило для алертов сервера и состояния в интерфейсе. */

/** Ожидаемо остановленный контейнер: одноразовая задача (migrate, certbot) завершилась кодом 0. */
export function isExpectedExit(restartPolicy: string, exitCode: number | null | undefined): boolean {
  return (restartPolicy === '' || restartPolicy === 'no') && exitCode === 0
}

/** Коды, с которыми контейнер останавливают руками: 143 — SIGTERM от `docker stop`, 137 — SIGKILL по его таймауту. */
const MANUAL_STOP_CODES = new Set([0, 137, 143])

/**
 * Контейнер лежит, хотя должен работать. Стек продукта (mainStack, по умолчанию — да): любая остановка, кроме
 * штатно завершённой одноразовой задачи. Соседние стеки на том же хосте — только то, что сам docker считает
 * сбоем: цикл перезапуска, исчерпанные попытки on-failure (код не 0/137/143) и dead. `exited` при always /
 * unless-stopped у них — остановлен руками (иначе docker поднял бы его сам), а policy «no» — разовый или
 * экспериментальный контейнер: виден, но алерта не поднимает. Убийства по нехватке памяти ловит отдельное правило.
 */
export function isContainerDown(c: {
  state: string
  restartPolicy: string
  exitCode: number | null | undefined
  mainStack?: boolean
}): boolean {
  if (c.state === 'running' || c.state === 'paused') return false
  if (c.state === 'restarting') return true
  if (c.state !== 'exited' && c.state !== 'dead') return false
  if (c.mainStack === false) {
    if (c.state === 'dead') return true
    return c.restartPolicy === 'on-failure' && typeof c.exitCode === 'number' && !MANUAL_STOP_CODES.has(c.exitCode)
  }
  return !isExpectedExit(c.restartPolicy, c.exitCode)
}
