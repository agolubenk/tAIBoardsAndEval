# Мобильная разработка — KMP + Android

> Источник: бывший `CLAUDE.md §Мобильная разработка`. Детали: `.claude/rules/15-mobile.md` (грузится по paths) · `apps/mobile/README.md` · UI Kit: `apps/mobile/ui-kit/README.md`.

**Статус:** Android MVP (KMP + Jetpack Compose). iOS — **реальное нативное SwiftUI-приложение** `apps/mobile-ios` (iOS 26+, Liquid Glass, сеть — нативный `URLSession`, KMP `MobileCore` не слинкован по умолчанию); детали — `apps/mobile-ios/CLAUDE.md`.

**Стек:** `shared/mobile-core/` (KMP: auth, session, Connect RPC, wiki, navigation) + `apps/mobile-android/` (Compose, Material 3). Gradle root: `apps/mobile/`. **Не** React Native / Expo.

**Скиллы для iOS UI** (любая модель/агент, см. `.claude/skills/VENDORED.md`): `apple-design` (пружины, жесты, материалы), `emil-design-eng` (анимировать ли, кривые, press-feedback), `write-swift` (Swift 6, concurrency, Swift Testing), `animate` / `review-animations`.

## Ключевые правила

- Токены: refresh → `SecureTokenStore` (Android: EncryptedSharedPreferences MasterKey AES256_GCM; iOS: Keychain); access → только in-memory (`SessionManager`). ❌ plain SharedPreferences/NSUserDefaults для refresh, ❌ access на диск
- Для native клиента refresh token приходит в JSON-теле (в отличие от web httpOnly cookie); заголовок `X-HrHelper-Client: native`
- Google OAuth native: Custom Tab → backend callback → deep link `hrhelper://auth/google?ticket=` (TTL 60 с, GETDEL) → `POST auth/mobile-oauth-handoff-consume`. ❌ tokens в URL
- Web handoff (mobile → SPA): `POST auth/web-handoff-ticket` → Custom Tab `/account/mobile-handoff?ticket=…` → httpOnly cookie (отдельная web-сессия)
- Типы/API: KMP DTO + `packages/types`; Connect RPC (`@hr-helper/rpc`, флаг `USE_CONNECT_RPC`) + REST fallback

## Сборка

```bash
cd apps/mobile && ./gradlew :mobile-android:assembleDebug
# API URL: apps/mobile/local.properties → hrhelper.api.url
```
