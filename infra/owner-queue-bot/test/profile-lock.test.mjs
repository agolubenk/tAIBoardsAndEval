// node --test infra/owner-queue-bot/test — замок профиля Chromium (SingletonLock → «хост-pid»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pidAlive, releaseStaleProfileLock } from '../profile-lock.mjs';

const exists = (p) => {
  try { lstatSync(p); return true; } catch { return false; }
};

function profile(lockTarget) {
  const dir = mkdtempSync(join(tmpdir(), 'oqb-lock-'));
  symlinkSync(lockTarget, join(dir, 'SingletonLock'));
  symlinkSync('/tmp/nonexistent/SingletonSocket', join(dir, 'SingletonSocket'));
  symlinkSync('1234567890', join(dir, 'SingletonCookie'));
  writeFileSync(join(dir, 'Local State'), '{}');
  return dir;
}

test('замок другого хоста (прошлый контейнер) снимается целиком, остальной профиль цел', () => {
  const dir = profile('a1ee6015dd4d-19');
  const logs = [];
  assert.equal(releaseStaleProfileLock(dir, { host: 'b2ff7126ee5e', alive: () => true, log: (m) => logs.push(m) }), true);
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) assert.equal(exists(join(dir, f)), false, f);
  assert.equal(existsSync(join(dir, 'Local State')), true);
  assert.match(logs[0], /a1ee6015dd4d-19/);
  rmSync(dir, { recursive: true, force: true });
});

test('свой хост, процесс мёртв (браузер упал) — снимается', () => {
  const dir = profile('mac-42');
  assert.equal(releaseStaleProfileLock(dir, { host: 'mac', alive: () => false }), true);
  assert.equal(exists(join(dir, 'SingletonLock')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('свой хост, процесс жив — живой браузер не трогаем: два Chromium на профиле его портят', () => {
  const dir = profile('mac-42');
  assert.equal(releaseStaleProfileLock(dir, { host: 'mac', alive: (pid) => pid === 42 }), false);
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) assert.equal(exists(join(dir, f)), true, f);
  rmSync(dir, { recursive: true, force: true });
});

test('хост с дефисами в имени разбирается по последнему дефису', () => {
  const dir = profile('vmi-3609987-77');
  assert.equal(releaseStaleProfileLock(dir, { host: 'vmi-3609987', alive: () => true }), false);
  assert.equal(releaseStaleProfileLock(dir, { host: 'vmi-3609987', alive: () => false }), true);
  rmSync(dir, { recursive: true, force: true });
});

test('замка нет — ничего не делаем; профиля нет — тоже', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oqb-lock-'));
  assert.equal(releaseStaleProfileLock(dir, { host: 'x', alive: () => false }), false);
  assert.equal(releaseStaleProfileLock(join(dir, 'нет-такого'), { host: 'x', alive: () => false }), false);
  rmSync(dir, { recursive: true, force: true });
});

test('pidAlive: свой процесс жив, несуществующий и мусор — нет', () => {
  assert.equal(pidAlive(process.pid), true);
  // pid 1 есть всегда; не-root получает EPERM — это «жив, но чужой», а не «нет такого».
  assert.equal(pidAlive(1), true);
  assert.equal(pidAlive(2 ** 22 + 12345), false);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(Number.NaN), false);
});
