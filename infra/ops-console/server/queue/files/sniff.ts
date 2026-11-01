/**
 * Тип вложения — по содержимому, не по имени и не по mimetype клиента (план files-plan v2). Белый список:
 * картинки, PDF, docx/xlsx без макросов, UTF-8 текст без разметки. Всё остальное — 415. Это второй ряд защиты:
 * первый — отдача только attachment + nosniff + CSP sandbox (routes/queue-files.ts).
 */
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'

export type FileKind = 'image' | 'pdf' | 'doc' | 'sheet' | 'text'
export interface Sniffed {
  kind: FileKind
  mime: string
  /** Расширение, под которое подстраивается имя (`отчёт.exe` с PDF внутри → `отчёт.pdf`). */
  ext: string
}

export class UnsupportedFileError extends Error {}

const ZIP_MAX_ENTRIES = 5000
const ZIP_MAX_CD_BYTES = 2 * 1024 * 1024
const CONTENT_TYPES_MAX_BYTES = 1024 * 1024
/** Между концом данных записи и следующим локальным заголовком — только дескриптор данных (до 24 байт с ZIP64-полями). */
const ZIP_MAX_GAP = 24

const startsWith = (buf: Buffer, sig: number[], at = 0) => sig.every((b, i) => buf[at + i] === b)

/** По первым байтам: картинка, PDF или «ZIP — разбирать дальше»; null — ни то ни другое (возможно, текст). */
export function sniffHead(head: Buffer): Sniffed | 'zip' | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mime: 'image/png', ext: 'png' }
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' }
  if (head.subarray(0, 6).toString('latin1') === 'GIF87a' || head.subarray(0, 6).toString('latin1') === 'GIF89a') {
    return { kind: 'image', mime: 'image/gif', ext: 'gif' }
  }
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { kind: 'image', mime: 'image/webp', ext: 'webp' }
  }
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return { kind: 'pdf', mime: 'application/pdf', ext: 'pdf' }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return 'zip'
  return null
}

interface ZipEntry {
  name: string
  flags: number
  method: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

async function readAt(fd: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await fd.read(buf, 0, length, position)
  if (bytesRead !== length) throw new UnsupportedFileError('ZIP обрезан')
  return buf
}

/**
 * docx/xlsx: центральный каталог И локальные заголовки. Расхождение имён, дубли, «дыры» между записями (спрятанные
 * локальные записи), больше 5000 записей, ZIP64 — отказ. Макросы (`vbaProject.bin`, `macroEnabled` в
 * `[Content_Types].xml`) — отказ. Распаковывается только `[Content_Types].xml` и только до 1 МБ.
 */
export async function sniffOoxml(path: string, size: number): Promise<Sniffed> {
  const fd = await open(path, 'r')
  try {
    const tailLen = Math.min(size, 22 + 0xffff)
    const tail = await readAt(fd, size - tailLen, tailLen)
    // Конец каталога — тот, у которого комментарий доходит ровно до конца файла (сигнатура может встретиться в комментарии).
    let eocdAt = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
        eocdAt = i
        break
      }
    }
    if (eocdAt < 0) throw new UnsupportedFileError('Не ZIP: нет конца каталога')
    const entriesTotal = tail.readUInt16LE(eocdAt + 10)
    const cdSize = tail.readUInt32LE(eocdAt + 12)
    const cdOffset = tail.readUInt32LE(eocdAt + 16)
    if (entriesTotal === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new UnsupportedFileError('ZIP64 не принимается')
    if (entriesTotal === 0 || entriesTotal > ZIP_MAX_ENTRIES || cdSize > ZIP_MAX_CD_BYTES) {
      throw new UnsupportedFileError('В архиве слишком много записей')
    }
    if (cdOffset + cdSize !== size - tailLen + eocdAt) throw new UnsupportedFileError('ZIP: каталог не на месте')
    const cd = await readAt(fd, cdOffset, cdSize)
    const entries: ZipEntry[] = []
    const names = new Set<string>()
    let p = 0
    for (let i = 0; i < entriesTotal; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new UnsupportedFileError('ZIP: битый каталог')
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8')
      if (names.has(name)) throw new UnsupportedFileError('ZIP: повтор имени записи')
      names.add(name)
      entries.push({
        name,
        flags: cd.readUInt16LE(p + 8),
        method: cd.readUInt16LE(p + 10),
        crc32: cd.readUInt32LE(p + 16),
        compressedSize: cd.readUInt32LE(p + 20),
        uncompressedSize: cd.readUInt32LE(p + 24),
        localOffset: cd.readUInt32LE(p + 42),
      })
      p += 46 + nameLen + extraLen + commentLen
    }
    // Локальные записи должны идти подряд от начала файла до каталога, без спрятанных между ними.
    const sorted = [...entries].sort((a, b) => a.localOffset - b.localOffset)
    let expected = 0
    let contentTypes: { entry: ZipEntry; dataAt: number } | null = null
    for (const e of sorted) {
      if (e.localOffset < expected || e.localOffset - expected > ZIP_MAX_GAP) throw new UnsupportedFileError('ZIP: записи не совпадают с каталогом')
      const lh = await readAt(fd, e.localOffset, 30)
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new UnsupportedFileError('ZIP: нет локального заголовка')
      const nameLen = lh.readUInt16LE(26)
      const extraLen = lh.readUInt16LE(28)
      const localName = (await readAt(fd, e.localOffset + 30, nameLen)).toString('utf8')
      if (localName !== e.name) throw new UnsupportedFileError('ZIP: имя в заголовке не совпадает с каталогом')
      if (!sameAsDirectory(lh, e)) throw new UnsupportedFileError('ZIP: заголовок записи не совпадает с каталогом')
      const dataAt = e.localOffset + 30 + nameLen + extraLen
      if (e.name === '[Content_Types].xml') contentTypes = { entry: e, dataAt }
      expected = dataAt + e.compressedSize
    }
    if (cdOffset < expected || cdOffset - expected > ZIP_MAX_GAP) throw new UnsupportedFileError('ZIP: записи не совпадают с каталогом')
    if ([...names].some((n) => /(^|\/)vbaproject\.bin$/i.test(n))) throw new UnsupportedFileError('Документ с макросами не принимается')
    const kind: FileKind | null = names.has('word/document.xml') ? 'doc' : names.has('xl/workbook.xml') ? 'sheet' : null
    if (!kind || !contentTypes) throw new UnsupportedFileError('Архив — не документ Word и не таблица Excel')
    const xml = await readContentTypes(fd, contentTypes.entry, contentTypes.dataAt)
    if (/macroenabled/i.test(xml)) throw new UnsupportedFileError('Документ с макросами не принимается')
    return kind === 'doc'
      ? { kind, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' }
      : { kind, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' }
  } finally {
    await fd.close()
  }
}

/**
 * Локальный заголовок говорит то же, что каталог: метод сжатия, флаг дескриптора, а без дескриптора — CRC и размеры.
 * Иначе распаковщик, который читает локальные поля, извлечёт не то, что проверили по каталогу (другой
 * [Content_Types].xml с макросами). С дескриптором (бит 3: так пишут Java и LibreOffice) локальные CRC и размеры
 * нулевые — тогда данные читаются по каталогу, как и здесь.
 */
function sameAsDirectory(lh: Buffer, e: ZipEntry): boolean {
  const flags = lh.readUInt16LE(6)
  if (lh.readUInt16LE(8) !== e.method || (flags & 0x08) !== (e.flags & 0x08)) return false
  if (flags & 0x08) return true
  return lh.readUInt32LE(14) === e.crc32 && lh.readUInt32LE(18) === e.compressedSize && lh.readUInt32LE(22) === e.uncompressedSize
}

async function readContentTypes(fd: Awaited<ReturnType<typeof open>>, e: ZipEntry, dataAt: number): Promise<string> {
  if (e.compressedSize > CONTENT_TYPES_MAX_BYTES * 2) throw new UnsupportedFileError('ZIP: [Content_Types].xml слишком большой')
  const raw = await readAt(fd, dataAt, e.compressedSize)
  if (e.method === 0) {
    if (raw.length > CONTENT_TYPES_MAX_BYTES) throw new UnsupportedFileError('ZIP: [Content_Types].xml слишком большой')
    return raw.toString('utf8')
  }
  if (e.method !== 8) throw new UnsupportedFileError('ZIP: неизвестное сжатие')
  try {
    return inflateRawSync(raw, { maxOutputLength: CONTENT_TYPES_MAX_BYTES }).toString('utf8')
  } catch {
    throw new UnsupportedFileError('ZIP: [Content_Types].xml не распаковывается или больше 1 МБ')
  }
}

/** Текст: валидный UTF-8 (потоком, без чтения в память), без NUL; первый значимый символ — не «<» (любая разметка). */
export async function sniffText(path: string): Promise<Sniffed> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let first: string | null = null
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 }) as AsyncIterable<Buffer>) {
      if (chunk.includes(0)) throw new UnsupportedFileError('Двоичный файл не принимается')
      const text = decoder.decode(chunk, { stream: true })
      if (first === null) {
        const significant = text.replace(/^[﻿ \t\r\n\f]+/, '')
        if (significant.length > 0) first = significant[0]!
      }
    }
    decoder.decode()
  } catch (e) {
    if (e instanceof UnsupportedFileError) throw e
    throw new UnsupportedFileError('Файл не текст в UTF-8')
  }
  if (first === '<') throw new UnsupportedFileError('Разметка (HTML, SVG, XML) не принимается')
  return { kind: 'text', mime: 'text/plain; charset=utf-8', ext: 'txt' }
}

/** Полная проверка файла во временном каталоге. */
export async function sniffFile(path: string, size: number, head: Buffer): Promise<Sniffed> {
  const h = sniffHead(head)
  if (h === 'zip') return sniffOoxml(path, size)
  if (h) return h
  return sniffText(path)
}
