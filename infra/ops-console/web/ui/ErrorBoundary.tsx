import { Component, type ErrorInfo, type ReactNode } from 'react'
import s from './styles'

/** Ошибка отрисовки одной страницы не должна гасить всю консоль (шапку, навигацию). */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ops] render error', error, info.componentStack)
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className={s.formError} role="alert">
        Страница не отрисовалась: {this.state.error.message}. Другие разделы работают — перейдите в них или обновите страницу.
      </div>
    )
  }
}
