import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Интеграционные тесты делят файл БД в пределах файла — без параллели внутри файла.
    fileParallelism: false,
    testTimeout: 20_000,
  },
})
