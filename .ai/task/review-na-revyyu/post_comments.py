#!/usr/bin/env python3
"""Постит вердикты сверки ревью-прохода 2026-08-19 в комментарии карточек «на ревью».

Канон: docs/guides/ops/notion-sync.md §«Порядок работы» п.2 — обсуждение живёт
на карточке, не в чате. Статусы НЕ меняются (C4: финальный переход — человек).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "infra" / "ai-council"))

import config as config_mod  # noqa: E402
import notion as notion_mod  # noqa: E402

COMMENTS = {
    # Баг Telegram
    "3badd207-a825-8076-977d-de8c75dfc5e3": """## Сверка ревью-прохода 2026-08-19 (код+git, независимо)

Коммит d6458d411 подтверждён по всем трём уровням: extractFirstUrl (telegram-sessions.controller.ts:169), parseSmItems (telegram-media-shared-content.service.ts:26), фронт-фильтр (TelegramPeerInfoModal.tsx:629), spec-файл на месте.

Из честно непроверенного остаются: живой прогон с активной TG-сессией и пересборка docker-образа SM — фикс SM вступает в силу только после build telegram-sessions. Готова к закрытию после ОК владельца.""",

    # Область эмодзи реакций
    "3badd207-a825-808b-88d3-c5a8ec535d22": """## Сверка ревью-прохода 2026-08-19

Коммит 39b249577 подтверждён: QUICK_ROW_COUNT=7, грид 8 колонок (ширина пикера не прыгает при развороте), aria-expanded/aria-label на месте, тест-файл существует.

Открытым остаётся вопрос из прошлого комментария: фиксированный список быстрых реакций или порядок каталога Telegram — ждёт решения владельца. Визуальная проверка в реальном чате — при ближайшем прогоне стека.""",

    # npm audit
    "3b9dd207-a825-8180-9715-d8bcd22c9a58": """## Сверка ревью-прохода 2026-08-19 — два незакрытых хвоста решения от 2026-08-15

1. Audit дрейфанул: после b48fddbdb было 4 находки, сейчас снова 7 (2 moderate + 5 high). Появились новые advisory по prisma / @prisma/config / deepmerge-ts поверх неустранённых @nestjs/swagger, js-yaml, exceljs, uuid. Lockfile с 08-15 не менялся — это новые advisory, а не регресс правок.
2. CI-гейт (шаг 2 решения: «сначала мажоры, потом блокирующий npm audit --audit-level=high») не реализован — в .github/workflows/ нет ни одного npm audit.

Предложение: либо вернуть карточку в работу на эти два пункта, либо закрыть эту как выполненную часть и завести новую под остаток. Решение за владельцем.""",

    # Onboarding
    "3b8dd207-a825-818a-94eb-dfd93f530909": """## Сверка ревью-прохода 2026-08-19

Оба коммита гибридизации подтверждены в истории: 556e151b7 (ролевой тоглер; RoleTabs/useRoleView вынесены в общие — оба хаба на одном компоненте) и 44215c93d (переопределение инстанса + spec onboarding-instance-viewer).

Ждёт ответа владельца по косметике меню из комментария 2026-08-17: смешение языков, «Онбординги 2.0» в названии пункта, /my-onboarding → /ps/onboarding/my.""",

    # Пользователи компании
    "3b8dd207-a825-818e-85ae-f98eaeba7d13": """## Сверка ревью-прохода 2026-08-19

Коммиты подтверждены: 38bdc7fe3 (страница /interviewers снята, роут → redirect /vacancies, authorizedRoutes.tsx:522) и 5f2460044 (реальные данные из rbac/users, моки удалены).

Попутная находка: DemoDataBanner после этих двух коммитов не имеет ни одного потребителя — мёртвый код, кандидат на удаление отдельной мелкой правкой.

Браузерный прогон «Пользователей компании» по-прежнему не делался — заявлено в Report честно, остаётся условием закрытия.""",

    # Файловая безопасность B-24
    "3b8dd207-a825-8199-86ea-c2f66db088d3": """## Сверка ревью-прохода 2026-08-19 (независимая) — вердикты ревью воспроизведены, НО код не закоммичен

Перепрогнано независимо, всё зелёное: telegram-media-response 9/9, fileSignature 40/40, typecheck @hr-helper/nestjs-api-v2 5/5 (--force, без stale cache), eslint по трём файлам чист.

Блокер: правки Finding 1/2 (candidate-photos.service.ts, telegram-media-response.util.ts + spec) лежат в рабочем дереве поверх fdac710f0 и НЕ закоммичены. Часть фикса уже в истории через автокоммит 69ab2e102 («+», ai-council-пайплайн). До коммита автором карточка не закрывается.

Остаток DoD без изменений: AV-сканер (блок на владельце), не-HTTP пути приёма, OnlyOffice в политике.""",

    # Dev Postgres
    "3b8dd207-a825-8139-9f6b-e0b185b4803a": """## Сверка ревью-прохода 2026-08-19

Раздел «Одна дев-БД на все ветки» подтверждён в .claude/rules/08-database-prisma.md:104-128: таблица «что чем делать», явный запрет migrate dev / migrate reset / db push --force-reset на общей БД, обязательная проверка information_schema перед применением чужого набора миграций.

Карточка ждёт решения владельца из комментария 2026-08-16: БД-на-ветку (hrhelper_<branch>) или остаёмся на общей с deploy/diff.""",

    # tsx/esbuild
    "3b8dd207-a825-819c-b2d0-e9d9a27286f1": """## Сверка ревью-прохода 2026-08-19

Фикс подтверждён: Dockerfile.backend:40 (npm rebuild bcrypt esbuild), комментарий о классе проблемы (postinstall + --ignore-scripts) на месте.

Живая пересборка образа так и не прогнана (стек погашен). При следующем подъёме: docker compose build backend, затем npx tsx --version внутри контейнера — если версия печатается, закрывать.""",

    # OnlyOffice
    "3b8dd207-a825-81c2-ad1c-e65300a7a651": """## Сверка ревью-прохода 2026-08-19

Сервис подтверждён в docker-compose.yml: ONLYOFFICE_DS_URL/JWT-env, profiles [onlyoffice] (opt-in), версия образа 8.2.2 зафиксирована, prod-оверлей fail-closed по секрету.

Контейнер backend-onlyoffice-1 сейчас Exited(137) — стек погашен. Сквозной сценарий «загрузил .doc → увидел превью» по-прежнему не проверен; проверять при полном подъёме стека вместе с MinIO (presigned URL изнутри DS-контейнера).""",

    # Retry-storm
    "3b8dd207-a825-8164-bc72-f5245ab9f206": """## Сверка ревью-прохода 2026-08-19

Single-flight подтверждён: telegram-avatar.service.ts:67 (карта in-flight по cacheKey, слот снимается в .finally), spec-файл на месте.

Живое воспроизведение по-прежнему невозможно без тестового TG-аккаунта (rules/16 §оговорка). Готова к закрытию после ОК владельца.""",

    # Wiki WIKI-8
    "3b8dd207-a825-81bb-b996e34e5fc880e6": """## Сверка ревью-прохода 2026-08-19

Все шесть PR подтверждены в коде и схеме: PR1 — emoji-mart в wikiIconUtils.tsx:5-6 (переиспользован, не новый пакет), PR2 — Space-метаданные (schema.prisma:3071-3077: icon/description/coverImageUrl), PR3 — WikiSidebar.tsx в features/wiki/ (+module.css), PR4 — модель WikiPageFavorite (:3247), PR5 — homePageId (:3077, relation CategoryHomePage), PR6 — isTemplate (:3114) + RAG-исключение (wiki-rag-index.repository.ts:15) + proto is_template. Миграции 20260813070000/080000/090000 в prisma/migrations на месте.

Остаток по заявке: визуальная проверка владельцем + запись в docs/plans/DONE.md при финальном закрытии (два обязательных шага закрытия, DONE.md пока не обновлён).""",
}


def main() -> None:
    cfg = config_mod.load(strict=False)
    client = notion_mod.build(cfg, dry_run=False)
    ok = fail = 0
    for page_id, text in COMMENTS.items():
        try:
            client.add_comment(page_id, text)
            ok += 1
            print(f"OK   {page_id}")
        except notion_mod.NotionError as exc:
            fail += 1
            print(f"FAIL {page_id}: {exc}")
    print(f"\nposted: {ok} / {len(COMMENTS)}, failed: {fail}")


if __name__ == "__main__":
    main()