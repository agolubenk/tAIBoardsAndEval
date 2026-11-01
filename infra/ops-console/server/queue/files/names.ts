/** Имя вложения: только для показа и для Content-Disposition; путь на диске — по id, без имени. */
import type { Sniffed } from './sniff'

const NAME_MAX = 120
/** Управляющие C0/C1 и bidi-переключатели (как normalizeOriginalFileName в packages/utils, #298). */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g
const TEXT_EXTS = new Set(['txt', 'log', 'csv', 'md', 'json', 'yaml', 'yml', 'out'])
const IMAGE_EXTS: Record<string, string[]> = { 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/gif': ['gif'], 'image/webp': ['webp'] }

function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? [name.slice(0, dot), name.slice(dot + 1).toLowerCase()] : [name, '']
}

/** Расширение, которое останется у имени: своё, если подходит типу содержимого, иначе — тип содержимого. */
function allowedExt(sniffed: Sniffed, own: string): string {
  if (sniffed.kind === 'text') return TEXT_EXTS.has(own) ? own : 'txt'
  if (sniffed.kind === 'image') return (IMAGE_EXTS[sniffed.mime] ?? [sniffed.ext]).includes(own) ? own : sniffed.ext
  return sniffed.ext
}

/** NFC, без управляющих и bidi, без путей и ведущих точек, не длиннее 120, расширение — по содержимому. */
export function displayName(raw: string, sniffed: Sniffed): string {
  let name = (raw || '').normalize('NFC').replace(UNSAFE, '').replace(/[\\/]+/g, '_').replace(/\s+/g, ' ').trim()
  name = name.replace(/^\.+/, '')
  const [base0, own] = splitExt(name)
  const ext = allowedExt(sniffed, own)
  const base = (base0 || 'file').slice(0, NAME_MAX - ext.length - 1).trim() || 'file'
  return `${base}.${ext}`
}

/** RFC 5987: в filename* — всё, кроме unreserved, в percent-encoding; запасной ASCII filename без пользовательского имени. */
export function contentDisposition(name: string, ext: string): string {
  const encoded = encodeURIComponent(name).replace(/['()*!]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return `attachment; filename="file.${ext.replace(/[^a-z0-9]/gi, '')}"; filename*=UTF-8''${encoded}`
}

/** Расширение уже очищенного имени (для запасного filename). */
export function extOf(name: string): string {
  return splitExt(name)[1] || 'bin'
}
