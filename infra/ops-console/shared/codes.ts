/** Код инцидента для людей и ссылок: INC-024 (консоль и Telegram-бот). */
export const incidentCode = (id: number) => `INC-${String(id).padStart(3, '0')}`
