// Конфиг и состояние бота — вне git, в ~/.hr-owner-queue-bot (права 700/600).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ALERT_BOTS } from './classify.mjs';

export const HOME = process.env.OQB_HOME || join(homedir(), '.hr-owner-queue-bot');
export const DEFAULT_ARTIFACT = 'https://ops.admin.hrhelper.space/queue';

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function writeJson(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export class Store {
  constructor() {
    mkdirSync(HOME, { recursive: true, mode: 0o700 });
    chmodSync(HOME, 0o700);
    this.configPath = join(HOME, 'config.json');
    this.statePath = join(HOME, 'state.json');
    this.config = readJson(this.configPath, {});
    this.state = readJson(this.statePath, { offset: 0, known: null, chats: {} });
    if (process.env.OQB_TOKEN) this.config.token = process.env.OQB_TOKEN;
    if (process.env.OQB_QUEUE_TOKEN) this.config.queueToken = process.env.OQB_QUEUE_TOKEN;
    if (process.env.OQB_QUEUE_URL) this.config.artifactUrl = process.env.OQB_QUEUE_URL;
    // Боты, чьи пересланные сообщения — алерты пульса (входящие из Telegram); по умолчанию бот алертов консоли.
    if (process.env.OQB_ALERT_BOTS) this.config.alertBots = process.env.OQB_ALERT_BOTS.split(',').map((s) => s.trim()).filter(Boolean);
    if (!Array.isArray(this.config.alertBots) || !this.config.alertBots.length) this.config.alertBots = DEFAULT_ALERT_BOTS;
    this.config.owners = Array.isArray(this.config.owners) ? this.config.owners.map(Number).filter(Boolean) : [];
    this.config.artifactUrl = this.config.artifactUrl || DEFAULT_ARTIFACT;
    if (typeof this.config.notify !== 'boolean') this.config.notify = true;
  }

  get profileDir() { return join(HOME, 'chrome-profile'); }

  saveConfig() {
    // Токен из переменной окружения на диск не пишем, если его там не было.
    const onDisk = readJson(this.configPath, {});
    const out = { ...this.config };
    if (process.env.OQB_TOKEN && !onDisk.token) delete out.token;
    if (process.env.OQB_QUEUE_TOKEN && !onDisk.queueToken) delete out.queueToken;
    writeJson(this.configPath, out);
  }

  saveState() { writeJson(this.statePath, this.state); }

  isOwner(userId) { return this.config.owners.includes(Number(userId)); }

  /** Привязка владельца: одноразовый код в файле pairing-code (виден только на этом Mac). */
  pairingCode() {
    const path = join(HOME, 'pairing-code');
    if (this.config.owners.length) return null;
    const saved = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
    if (/^\d{6}$/.test(saved)) return saved;
    const code = String(randomInt(100000, 999999));
    writeFileSync(path, code, { mode: 0o600 });
    return code;
  }

  /** После блокировки перебора — новый код при следующем запуске (старый мог утечь). */
  resetPairing() {
    try { unlinkSync(join(HOME, 'pairing-code')); } catch { /* уже нет */ }
  }

  pair(userId, code) {
    const expected = this.pairingCode();
    if (!expected || String(code).trim() !== expected) return false;
    this.config.owners.push(Number(userId));
    this.saveConfig();
    try { unlinkSync(join(HOME, 'pairing-code')); } catch { /* не критично */ }
    return true;
  }
}
