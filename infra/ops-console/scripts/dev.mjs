// Dev-режим: API (tsx watch, :8797) + Vite с HMR (:5180, прокси /api). Ctrl+C гасит оба.
import { spawn } from 'node:child_process'

const procs = [
  spawn('npm', ['run', 'dev:api'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn('npm', ['run', 'dev:web'], { stdio: 'inherit', shell: process.platform === 'win32' }),
]
const stop = () => procs.forEach((p) => p.kill('SIGTERM'))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
procs.forEach((p) =>
  p.on('exit', (code) => {
    stop()
    process.exit(code ?? 0)
  }),
)
