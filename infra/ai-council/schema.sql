-- AI Council — схема состояния. Канон: docs/specs/ai-council.md §13.
-- Всё межпроцессное взаимодействие идёт через эту БД: очередь (runs), транскрипты (messages),
-- корпус (corpus*), аудит записи в Notion (notion_writes). Брокера нет и не нужно.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER);

-- ── Снапшот борда ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cards (
  card_id            TEXT PRIMARY KEY,
  db                 TEXT NOT NULL,            -- tasks | bugs
  title              TEXT,
  url                TEXT,
  status             TEXT,
  priority           TEXT,                     -- P0..P3 (только tasks)
  severity           TEXT,                     -- critical..low (только bugs)
  task_type          TEXT,
  source             TEXT,
  backlog_id         TEXT,
  modules            TEXT,                     -- JSON []
  tags               TEXT,                     -- JSON [] (свойство появится после шага S1)
  half_baked         INTEGER NOT NULL DEFAULT 0,
  parent_card_id     TEXT,
  subtask_ids        TEXT,                     -- JSON []
  report             TEXT,
  body               TEXT,                     -- плоский текст блоков страницы
  comments           TEXT,                     -- JSON [{author, text, at}]
  content_hash       TEXT,                     -- sha16 значимого содержимого → триггер переработки
  notion_edited_at   TEXT,
  fetched_at         INTEGER
);
CREATE INDEX IF NOT EXISTS cards_open ON cards(db, status);

-- ── Очередь и прогоны ───────────────────────────────────────────────────────
-- Захват задачи воркером — только через BEGIN IMMEDIATE + UPDATE ... WHERE status='queued'
-- (см. store.claim_run). Тот же принцип, что требует .claude/rules/00-antipatterns.md
-- для outbox: без транзакционного захвата несколько воркеров разберут одну запись.
CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  card_id      TEXT,
  track        TEXT NOT NULL DEFAULT 'elaborate',  -- elaborate | triage | half_baked | plan
  profile      TEXT NOT NULL DEFAULT 'fast',       -- fast | deep
  status       TEXT NOT NULL DEFAULT 'queued',     -- queued|running|done|abstained|failed|cancelled
  priority     INTEGER NOT NULL DEFAULT 0,
  claimed_by   TEXT,
  claimed_at   INTEGER,
  heartbeat_at INTEGER,
  outcome      TEXT,
  confidence   REAL,
  readiness    REAL,
  payload      TEXT,                               -- итоговый JSON §7
  config_hash  TEXT,
  git_sha      TEXT,
  card_hash    TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER,
  started_at   INTEGER,
  finished_at  INTEGER,
  wall_ms      INTEGER,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS runs_queue  ON runs(status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS runs_card   ON runs(card_id, created_at DESC);

-- ── Транскрипт: каждый вызов модели, полностью воспроизводимо ───────────────
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL,
  round       INTEGER,
  role        TEXT,
  model       TEXT,
  prompt_sha  TEXT,
  prompt      TEXT,
  response    TEXT,
  ok          INTEGER,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  ms          INTEGER,
  created_at  INTEGER
);
CREATE INDEX IF NOT EXISTS messages_run ON messages(run_id, round, id);

CREATE TABLE IF NOT EXISTS proposals (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL,
  role           TEXT,
  model          TEXT,
  payload        TEXT,
  grounded_score REAL,
  review_score   REAL,
  total_score    REAL,
  created_at     INTEGER
);
CREATE INDEX IF NOT EXISTS proposals_run ON proposals(run_id);

CREATE TABLE IF NOT EXISTS reviews (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  reviewer_model  TEXT,
  reviewer_role   TEXT,
  target_proposal TEXT,
  scores          TEXT,      -- JSON рубрики
  objections      TEXT,      -- JSON []
  weight          REAL DEFAULT 1.0,
  created_at      INTEGER
);
CREATE INDEX IF NOT EXISTS reviews_run ON reviews(run_id);

CREATE TABLE IF NOT EXISTS verifications (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         TEXT NOT NULL,
  proposal_id    TEXT,
  checked        TEXT,       -- JSON [{kind, ref, ok, via}]
  hallucinations TEXT,       -- JSON []
  passed         INTEGER,
  created_at     INTEGER
);
CREATE INDEX IF NOT EXISTS verifications_run ON verifications(run_id);

-- ── Обучение ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS verdicts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         TEXT NOT NULL,
  decision       TEXT,       -- accept | edit | reject
  comment        TEXT,
  edited_payload TEXT,
  created_at     INTEGER
);
CREATE INDEX IF NOT EXISTS verdicts_run ON verdicts(run_id);

CREATE TABLE IF NOT EXISTS model_stats (
  model      TEXT NOT NULL,
  role       TEXT NOT NULL,
  module     TEXT NOT NULL DEFAULT '*',
  alpha      REAL NOT NULL DEFAULT 1.0,
  beta       REAL NOT NULL DEFAULT 1.0,
  updated_at INTEGER,
  PRIMARY KEY (model, role, module)
);

-- Что уже учтено в model_stats. Без этого повторный проход learning.py начислял бы
-- те же вердикты второй раз, и апостериорная надёжность росла бы от частоты запуска
-- сервиса, а не от качества моделей. Ключ — источник сигнала, а не прогон: у одного
-- прогона несколько предложений, у каждого своя верификация.
CREATE TABLE IF NOT EXISTS learning_ledger (
  kind       TEXT NOT NULL,     -- verdict | hallucination
  ref        TEXT NOT NULL,     -- verdicts.id | verifications.id
  run_id     TEXT,
  detail     TEXT,              -- JSON: кому и сколько начислено
  applied_at INTEGER,
  PRIMARY KEY (kind, ref)
);
CREATE INDEX IF NOT EXISTS learning_ledger_run ON learning_ledger(run_id);

-- Дрейф рубрики (§9, механизм 4). Автоприменения нет по построению: промпты и рубрика
-- версионируются в git, поэтому здесь копятся ПРЕДЛОЖЕНИЯ с уликами, а решение —
-- владельца (status). cluster_key = sha16 нормализованного паттерна: повторная
-- кластеризация обновляет счётчик, а не плодит дубли.
CREATE TABLE IF NOT EXISTS rubric_suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_key TEXT UNIQUE,
  pattern     TEXT,             -- короткое имя кластера причин
  suggestion  TEXT,             -- что предлагается дописать
  target      TEXT,             -- prompts/<name>.md | rubric
  hits        INTEGER NOT NULL DEFAULT 0,
  evidence    TEXT,             -- JSON [{run_id, decision, comment}]
  model       TEXT,             -- кто кластеризовал
  status      TEXT NOT NULL DEFAULT 'new',   -- new | applied | dismissed
  created_at  INTEGER,
  updated_at  INTEGER,
  decided_at  INTEGER
);
CREATE INDEX IF NOT EXISTS rubric_suggestions_status ON rubric_suggestions(status, hits DESC);

-- ── Корпус консилиума (динамический RAG) ────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS corpus USING fts5(
  doc_id UNINDEXED, kind, title, content, module, tokenize = 'unicode61'
);
CREATE TABLE IF NOT EXISTS corpus_meta (
  doc_id       TEXT PRIMARY KEY,
  kind         TEXT,        -- card | comment | done_md | verdict | exemplar
  source_ref   TEXT,
  module       TEXT,
  content_hash TEXT,
  indexed_at   INTEGER
);
CREATE TABLE IF NOT EXISTS corpus_vec (
  doc_id TEXT PRIMARY KEY, dim INTEGER, vec BLOB, model TEXT, embedded_at INTEGER
);

-- ── План ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id          TEXT PRIMARY KEY,
  window_from TEXT, window_to TEXT,
  items       TEXT,          -- JSON []
  overflow    TEXT,          -- JSON [] не поместившееся
  needs_human TEXT,          -- JSON []
  config_hash TEXT,
  emitted_to  TEXT,
  created_at  INTEGER
);

-- ── Модельный лок: инвариант «не более одной L-модели резидентно» (§4) ──────
CREATE TABLE IF NOT EXISTS locks (
  name        TEXT PRIMARY KEY,
  holder      TEXT,
  model       TEXT,
  acquired_at INTEGER,
  expires_at  INTEGER
);

-- ── Идемпотентность создания страниц (§10) ──────────────────────────────────
-- Удаления/архивации у консилиума нет: ошибочно созданная карточка остаётся навсегда.
CREATE TABLE IF NOT EXISTS created_pages (
  child_key      TEXT PRIMARY KEY,   -- sha16(parent_card_id + normalized_title)
  page_id        TEXT,
  parent_card_id TEXT,
  db             TEXT,
  title          TEXT,
  run_id         TEXT,
  created_at     INTEGER
);

-- ── Аудит записи наружу: то, чем откатывается неудачный прогон ──────────────
CREATE TABLE IF NOT EXISTS notion_writes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT,
  page_id    TEXT,
  op         TEXT,     -- property | comment | body | create | relation | tag
  field      TEXT,
  before     TEXT,
  after      TEXT,
  ok         INTEGER,
  dry_run    INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS notion_writes_run  ON notion_writes(run_id);
CREATE INDEX IF NOT EXISTS notion_writes_page ON notion_writes(page_id, created_at DESC);

-- ── Кэш расширения поисковых терминов ───────────────────────────────────────
-- Русскоязычная карточка даёт 1-2 латинских термина, чего для BM25 по англоязычному
-- индексу недостаточно. Расширяем локальной моделью — но не на каждый прогон:
-- ключ = content_hash карточки, так что текст не менялся → термины берутся из кэша.
CREATE TABLE IF NOT EXISTS term_cache (
  card_hash  TEXT PRIMARY KEY,
  terms      TEXT,
  model      TEXT,
  created_at INTEGER
);

-- ── Учёт облачных вызовов: единственный источник правды по тратам ───────────
-- Локальный ярус бесплатен, облачный — нет. Дневные лимиты (cloud.py) считаются
-- по этой таблице, поэтому сюда пишутся и отказы по бюджету (ok=0, refused<>''):
-- «сколько раз консилиум ХОТЕЛ в облако» — это диагностика неверных порогов эскалации.
CREATE TABLE IF NOT EXISTS cloud_usage (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT,
  role       TEXT,
  provider   TEXT,     -- zai | gemini
  model      TEXT,
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  usd        REAL    NOT NULL DEFAULT 0,
  ms         INTEGER NOT NULL DEFAULT 0,
  ok         INTEGER NOT NULL DEFAULT 0,
  refused    TEXT,     -- непусто = вызов не состоялся, причина по бюджету
  error      TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS cloud_usage_day ON cloud_usage(created_at DESC);
CREATE INDEX IF NOT EXISTS cloud_usage_run ON cloud_usage(run_id);

-- ── Служебное: события для SSE в gateway ────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT,
  ref        TEXT,
  detail     TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS events_tail ON events(id DESC);

-- ── Указания владельца к карточке ───────────────────────────────────────────
-- То, что владелец знает о задаче, а карточка не содержит: «трогать только бэкенд»,
-- «прошлый подход не сработал, потому что…», «начни с миграции». Кладётся в pinned-часть
-- капсулы с явным приоритетом над выводами из кода (retrieval.build → user_constraints).
--
-- Живёт на КАРТОЧКЕ, а не на прогоне: указание переживает прогоны и применяется к каждому
-- следующему, иначе его пришлось бы вводить заново перед каждым запуском — ровно та
-- работа, ради избавления от которой оно и заводится. История правок сохраняется
-- (append-only + флаг active), потому что «что мы говорили консилиуму на прошлом прогоне»
-- — это часть объяснения, почему прогон дал такой результат.
CREATE TABLE IF NOT EXISTS card_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id    TEXT NOT NULL,
  note       TEXT NOT NULL,
  author     TEXT NOT NULL DEFAULT 'owner',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS card_notes_card ON card_notes(card_id, active, id DESC);

-- ── Рабочие сессии владельца (v2, решение B) ────────────────────────────────
-- Сессия = интервал работы владельца от запуска до остановки, границы задаёт UI,
-- а не цепочка карточек. Контекст принадлежит СЕССИИ: за сессию сколько угодно
-- карточек; свёртка генерируется ОДИН раз на закрытии (context_service.
-- summarize_session) и переиспользуется в новых сессиях как pinned-улика.
-- Прогоны вне открытой сессии сюда не попадают.
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  title          TEXT,
  opened_at      INTEGER,
  closed_at      INTEGER,
  status         TEXT NOT NULL DEFAULT 'open',   -- open | closed
  summary        TEXT,                           -- итоговый контекст (свёртка закрытия)
  summary_model  TEXT,
  summary_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_status ON sessions(status, opened_at DESC);

-- Прогон приписан сессии, если завершился (done|abstained), пока она была открыта.
-- INSERT OR IGNORE: повторная приписка (ретрай, эскалация fast→deep) не дублирует.
CREATE TABLE IF NOT EXISTS session_runs (
  session_id TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  added_at   INTEGER,
  PRIMARY KEY (session_id, run_id)
);

-- Свёртка отдельной таблицей: version растёт при перевёртке, source_run_id указывает
-- прогон, на котором сгенерирован текущий текст. sessions.summary — то же самое
-- одним полем для быстрого чтения списка сессий.
CREATE TABLE IF NOT EXISTS session_contexts (
  session_id    TEXT PRIMARY KEY,
  summary       TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  source_run_id TEXT,
  updated_at    INTEGER
);


-- ── Ревью-оркестрация (вкладка «Ревью», review_*.py) ────────────────────────
-- Отдельный контур, а не трек в `runs`: планировщик и обучение читают runs по card_id
-- без фильтра по треку — payload ревью они приняли бы за проработку. Исполняет тот же
-- council_worker (локальные модели строго последовательно — один процесс на инференс).
--
-- Настройки — JSON-спеки (`spec`), валидируются кодом (review_catalog.validate_*):
-- поля профиля/агента меняются чаще схемы, а миграции SQLite дороже чтения JSON.

-- Снапшот очереди «на ревью». Не таблица cards: её целиком читает планировщик, и
-- карточки на ревью всплыли бы в «нужен человек» как непроработанные.
CREATE TABLE IF NOT EXISTS review_cards (
  card_id          TEXT PRIMARY KEY,
  board            TEXT NOT NULL,              -- bugs | tasks
  title            TEXT,
  url              TEXT,
  status           TEXT,
  priority         TEXT,
  severity         TEXT,
  task_type        TEXT,
  backlog_id       TEXT,
  modules          TEXT,                       -- JSON []
  tags             TEXT,                       -- JSON []
  half_baked       INTEGER NOT NULL DEFAULT 0,
  report           TEXT,
  body             TEXT,                       -- с блоком council:v1 — прошлая проработка = контекст ревью
  comments         TEXT,                       -- JSON [{id, text, at}]
  review_hash      TEXT,                       -- хэш значимого БЕЗ собственных комментариев ревью
  notion_edited_at TEXT,
  in_queue         INTEGER NOT NULL DEFAULT 1, -- 0 = ушла из статуса ревью
  first_seen_at    INTEGER,                    -- вход в текущий цикл ревью
  last_seen_at     INTEGER,
  fetched_at       INTEGER
);
CREATE INDEX IF NOT EXISTS review_cards_queue ON review_cards(in_queue, board);

CREATE TABLE IF NOT EXISTS review_profiles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  spec        TEXT NOT NULL,                   -- JSON: method, participants, agents, tokens, verdict…
  is_default  INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER,
  updated_at  INTEGER
);

-- История версий профиля: прогон хранит снимок, а эта таблица отвечает на «что поменяли».
CREATE TABLE IF NOT EXISTS review_profile_versions (
  profile_id  TEXT NOT NULL,
  version     INTEGER NOT NULL,
  spec        TEXT NOT NULL,
  saved_at    INTEGER,
  PRIMARY KEY (profile_id, version)
);

CREATE TABLE IF NOT EXISTS review_agents (
  key         TEXT PRIMARY KEY,
  spec        TEXT NOT NULL,                   -- JSON: label, kind, focus, model, params, triggers…
  builtin     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS review_boards (
  board       TEXT PRIMARY KEY,                -- bugs | tasks
  spec        TEXT NOT NULL,                   -- JSON: review_status, переходы, auto_run, profile_id…
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS review_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,                            -- JSON
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS review_runs (
  id                TEXT PRIMARY KEY,
  card_id           TEXT NOT NULL,
  board             TEXT,
  card_title        TEXT,
  card_hash         TEXT,                      -- review_hash на момент постановки
  status            TEXT NOT NULL DEFAULT 'queued',  -- queued|running|done|failed|cancelled
  priority          INTEGER NOT NULL DEFAULT 0,
  requested_by      TEXT,                      -- ui | mcp | cli | auto
  profile_id        TEXT,
  profile_name      TEXT,
  method            TEXT,
  request           TEXT,                      -- JSON: разовые оверрайды (агенты, метод, заметка)
  snapshot          TEXT,                      -- JSON: неизменяемый снимок условий запуска
  verdict           TEXT,                      -- ACCEPT | FAIL | NEEDS_HUMAN | INCONCLUSIVE
  confidence        REAL,
  summary           TEXT,
  result            TEXT,                      -- JSON: голоса, находки, судья, трасса политики
  transition_target TEXT,
  transition_state  TEXT NOT NULL DEFAULT 'none',  -- none|proposed|applied|rejected|skipped|failed
  transition_note   TEXT,
  transition_at     INTEGER,
  transition_by     TEXT,
  comment_state     TEXT NOT NULL DEFAULT 'none',  -- none|posted|failed|skipped
  cancel_requested  INTEGER NOT NULL DEFAULT 0,
  claimed_by        TEXT,
  heartbeat_at      INTEGER,
  attempts          INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER,
  started_at        INTEGER,
  finished_at       INTEGER,
  wall_ms           INTEGER,
  error             TEXT
);
CREATE INDEX IF NOT EXISTS review_runs_queue ON review_runs(status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS review_runs_card  ON review_runs(card_id, created_at DESC);

-- Транскрипт ревью: каждый вызов модели с эффективными параметрами — воспроизводимо.
CREATE TABLE IF NOT EXISTS review_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL,
  stage_no    INTEGER,
  stage_type  TEXT,
  agent_key   TEXT,
  model       TEXT,
  params      TEXT,                            -- JSON: options Ollama, как ушли в запрос
  prompt      TEXT,
  response    TEXT,
  data        TEXT,                            -- распарсенный JSON ответа
  ok          INTEGER,
  error       TEXT,
  ms          INTEGER,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  created_at  INTEGER
);
CREATE INDEX IF NOT EXISTS review_steps_run ON review_steps(run_id, id);

-- Аудит действий ревью вне БД: смена статуса, комментарий, отказ человека.
CREATE TABLE IF NOT EXISTS review_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT,
  card_id     TEXT,
  action      TEXT,                            -- transition.proposed|applied|rejected|skipped|failed, comment.*
  actor       TEXT,                            -- ai | ui | mcp | cli
  from_status TEXT,
  to_status   TEXT,
  detail      TEXT,
  at          INTEGER
);
CREATE INDEX IF NOT EXISTS review_audit_run ON review_audit(run_id, id);

-- Общее состояние процессов консилиума (queue_control.py): глобальная пауза очереди,
-- зеркало блокировок memory-guard для UI/MCP. Маленькая kv-таблица вместо флагов в
-- config.toml: состояние меняется на лету и не должно попадать в git.
CREATE TABLE IF NOT EXISTS council_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER
);
