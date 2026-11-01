// Замок профиля Chromium. Браузер держит в профиле ссылку SingletonLock → «<хост>-<pid>» и снимает её при
// закрытии. Убитый без закрытия (docker rm -f, SIGKILL, OOM) оставляет её, и следующий запуск отказывается:
// «The profile appears to be in use by another Chromium process … on another computer» — у нового контейнера
// другое имя хоста (20.10: бот не поднялся после обновления). Снимаем только чужой или мёртвый замок; живой
// браузер на этом же хосте не трогаем — два Chromium на одном профиле портят его.
import { readlinkSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

/** Жив ли процесс: EPERM — жив, но чужой; ESRCH — нет такого. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/**
 * Снять оставшийся замок профиля перед запуском браузера. true — замок был и снят; false — замка нет или он
 * живой (тот же хост, процесс жив): тогда Chromium откажет сам, как и должен.
 */
export function releaseStaleProfileLock(profileDir, { host = hostname(), alive = pidAlive, log } = {}) {
  let target;
  try {
    target = readlinkSync(join(profileDir, 'SingletonLock'));
  } catch {
    return false; // замка нет (или это не ссылка — не наш формат, не трогаем)
  }
  const m = /^(.+)-(\d+)$/.exec(target);
  if (m && m[1] === host && alive(Number(m[2]))) return false;
  for (const name of SINGLETON_FILES) rmSync(join(profileDir, name), { force: true });
  log?.(`снят оставшийся замок профиля Chromium (${target}): прошлый браузер закрылся не сам`);
  return true;
}
