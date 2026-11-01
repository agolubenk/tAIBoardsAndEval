import { describe, expect, it } from 'vitest'
import { tlsConnectTarget } from '../server/monitors/tls'

/**
 * Проверка сертификатов ходит по тем же правилам исходящих запросов, что и HTTP-мониторы: монитор
 * заводит оператор, и без этого TLS-проверка была бы способом прощупать внутреннюю сеть на :443.
 */
describe('TLS-проверка: куда можно подключаться', () => {
  it('внутренние адреса и loopback — отказ, если их нет во «Внутренних адресах»', async () => {
    for (const domain of ['127.0.0.1', 'localhost', '10.0.0.5', '192.168.1.10', '[::1]']) {
      await expect(tlsConnectTarget(domain)).rejects.toThrow()
    }
  })

  it('метаданные облака запрещены всегда — даже если адрес добавить в разрешённые', async () => {
    await expect(tlsConnectTarget('169.254.169.254', ['169.254.169.254'])).rejects.toThrow(/запрещ/)
  })

  it('разрешённый внутренний адрес и публичный — подключение к проверенному адресу, SNI только для имён', async () => {
    await expect(tlsConnectTarget('10.0.0.5', ['10.0.0.5'])).resolves.toEqual({ host: '10.0.0.5', servername: undefined })
    await expect(tlsConnectTarget('1.1.1.1')).resolves.toEqual({ host: '1.1.1.1', servername: undefined })
  })
})
