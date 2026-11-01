/** Русское склонение по числу: plural(3, ['алерт', 'алерта', 'алертов']) → «3 алерта». */
export function plural(n: number, forms: readonly [one: string, few: string, many: string], withNumber = true): string {
  const a = Math.abs(n) % 100
  const b = a % 10
  const form = a > 10 && a < 20 ? forms[2] : b > 1 && b < 5 ? forms[1] : b === 1 ? forms[0] : forms[2]
  return withNumber ? `${n} ${form}` : form
}
