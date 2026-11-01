/**
 * Криптопримитивы консоли — только node:crypto.
 *
 * - секреты в БД: AES-256-GCM (`v1:<iv>:<tag>:<data>`, base64url), ключ — OPS_ENCRYPTION_KEY;
 * - пароли: scrypt (N=16384, r=8, p=1), сравнение timingSafeEqual;
 * - подписи агентов/webhook: HMAC-SHA256, сравнение timingSafeEqual.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { getEnv } from '../env'

const b64 = (b: Buffer) => b.toString('base64url')
const unb64 = (s: string) => Buffer.from(s, 'base64url')

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getEnv().encryptionKey, iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `v1:${b64(iv)}:${b64(cipher.getAuthTag())}:${b64(data)}`
}

export function decryptSecret(enc: string): string {
  const [v, iv, tag, data] = enc.split(':')
  if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('unsupported secret format')
  const decipher = createDecipheriv('aes-256-gcm', getEnv().encryptionKey, unb64(iv))
  decipher.setAuthTag(unb64(tag))
  return Buffer.concat([decipher.update(unb64(data)), decipher.final()]).toString('utf8')
}

export function encryptJson(value: Record<string, string>): string {
  return encryptSecret(JSON.stringify(value))
}

export function decryptJson(enc: string | null | undefined): Record<string, string> {
  if (!enc) return {}
  const parsed: unknown = JSON.parse(decryptSecret(enc))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v
  return out
}

/** Маска для показа: последние 4 символа. */
export function maskSecret(secret: string | undefined | null): string | null {
  if (!secret) return null
  return `••••${secret.slice(-4)}`
}

export function randomToken(bytes = 32): string {
  return b64(randomBytes(bytes))
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

export function hmacHex(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

// ── Пароли ──────────────────────────────────────────────────────────────────

const SCRYPT_N = 16384
const SCRYPT_KEYLEN = 64

function scryptAsync(password: string, salt: Buffer, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEYLEN, { N: n, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scryptAsync(password, salt, SCRYPT_N)
  return `scrypt$${SCRYPT_N}$${b64(salt)}$${b64(key)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, nRaw, salt, key] = stored.split('$')
  if (algo !== 'scrypt' || !nRaw || !salt || !key) return false
  const derived = await scryptAsync(password, unb64(salt), Number(nRaw))
  const expected = unb64(key)
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}
