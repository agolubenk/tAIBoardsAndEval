---
paths:
  - apps/mobile/**
  - apps/mobile-android/**
  - apps/mobile-ios/**
  - shared/mobile-core/**
---

# Мобильная разработка — KMP + Jetpack Compose

> **Sync:** Спека: `docs/specs/mobile-app.md`

## Стек (фактический)

| Слой | Путь | Статус |
|------|------|--------|
| **KMP shared** | `shared/mobile-core/` | auth, session, Connect RPC, wiki, navigation |
| **Android UI** | `apps/mobile-android/` | Jetpack Compose, Material 3 |
| **Gradle root** | `apps/mobile/` | wrapper + `settings.gradle.kts` |
| **iOS app** | `apps/mobile-ios/` | **реальное нативное SwiftUI-приложение** (Xcode-проект `HRHelper.xcodeproj`, iOS **26+** / Liquid Glass API; с 2026-09-30 живые Telegram и workflow-чат, свой socket.io-клиент `Networking/Realtime/`, проверка без симулятора — `scripts/typecheck.sh` + `scripts/test-logic.sh`, см. `apps/mobile-ios/CLAUDE.md`). Сеть — **нативный Swift** `URLSession` (`Networking/ApiClient.swift`, зеркалит контракт KMP `HrHelperApiClient` вручную: `X-HrHelper-Client: native`, bearer + single-retry-on-401), **не** KMP. KMP `MobileCore` — **не подключен по умолчанию**, линковка через `scripts/link-mobile-core.sh` опциональна и требует ручного шага (`./gradlew :mobile-core:linkDebugFrameworkIosSimulatorArm64` + скрипт + embed в Xcode). Проверено по факту дерева/README/git-истории 2026-09-10 — предыдущая версия этой строки утверждала «нет iOS app» (устарело), промежуточная правка этой же сессии ошибочно утверждала, что MobileCore уже слинкован (тоже неверно — исправлено) |
| **React Native / Expo** | — | **не используется** |

## Разделение типов и API

- Типы/DTO — в KMP (`shared/mobile-core`) или `packages/types` для общих контрактов с backend
- REST: `HrHelperApiClient` + заголовок `X-HrHelper-Client: native`
- Connect RPC: `@hr-helper/rpc` gen types, feature flag `USE_CONNECT_RPC` в Android
- Refresh token в JSON-теле (native); web — httpOnly cookie

## Аутентификация и хранение токенов

```kotlin
// SessionManager: access — in-memory; refresh — SecureTokenStore
session.persistTokens(tokens)  // refresh → secure storage, access → RAM

// Android: EncryptedSharedPreferences (MasterKey AES256_GCM)
// iOS: Keychain kSecClassGenericPassword (SecureTokenStore.ios.kt)

// ❌ NSUserDefaults / plain SharedPreferences для refresh token
// ❌ access token на диск
```

## OAuth (Google native)

1. Custom Tab → backend Google OAuth callback
2. Deep link: `hrhelper://auth/google?ticket=<one-time>` (TTL 60 с, Redis GETDEL)
3. Mobile: `POST auth/mobile-oauth-handoff-consume` → tokens / 2FA
4. ❌ `access_token` / `refresh_token` в query URL

## Web handoff (mobile → SPA Custom Tab)

1. `POST auth/web-handoff-ticket` (native + refresh)
2. Custom Tab → `/account/mobile-handoff?ticket=…`
3. SPA `consumeWebHandoffTicket` → httpOnly cookie (отдельная web-сессия)

## Real-time / background

- Android: закрывать Custom Tab / отменять in-flight при `onStop` где уместно
- SSE ticket auth на backend — `POST auth/sse-ticket` (не Bearer в URL)
- FCM — вне текущего MVP

## Сборка и dev

```bash
cd apps/mobile
./gradlew :mobile-android:assembleDebug
# API URL: apps/mobile/local.properties → hrhelper.api.url
```

Детали: `apps/mobile/README.md` · **UI Kit:** `apps/mobile/ui-kit/README.md`
