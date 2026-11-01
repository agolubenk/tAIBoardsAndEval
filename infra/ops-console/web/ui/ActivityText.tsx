/**
 * Сообщение ленты. Сервер помечает события эмодзи (🔴 🟠 🟢 ✅ ❌ — так же они уходят в
 * Telegram); в консоли вместо них — точка статуса в цветах интерфейса и скрытая подпись для
 * скринридера, чтобы смысл не держался на одном цвете.
 */
const LEAD: Record<string, [label: string, color: string]> = {
  '🔴': ['Критично', 'var(--st-critical)'],
  '❌': ['Ошибка', 'var(--st-critical)'],
  '🟠': ['Внимание', 'var(--st-warning)'],
  '🟢': ['Восстановлено', 'var(--st-healthy)'],
  '✅': ['Успешно', 'var(--st-healthy)'],
}

const DOT = { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 8, verticalAlign: 1 } as const

export function splitActivity(message: string): { lead: [string, string] | null; text: string } {
  const first = [...message][0] ?? ''
  const lead = LEAD[first]
  return lead ? { lead, text: message.slice(first.length).trimStart() } : { lead: null, text: message }
}

export function ActivityDot({ message }: { message: string }) {
  const { lead } = splitActivity(message)
  if (!lead) return null
  return (
    <>
      <span aria-hidden style={{ ...DOT, background: lead[1] }} />
      <span className="visually-hidden">{lead[0]}: </span>
    </>
  )
}

export const activityText = (message: string) => splitActivity(message).text
