# Архитектура рантайма

Гейты (`tests/arch.test.mjs`) держат это в силе автоматически: слои, бюджеты строк,
реестр видов узлов — всё описанное ниже проверяется, а не только документируется.

## Слои

Снизу вверх; модуль импортирует только то, что явно перечислено в
`tests/arch.test.mjs`'s `ALLOWED` (циклов нет, реестр импортов вынесен из прозы в тест).

| слой | модули | зачем |
|---|---|---|
| 0 | `fields.mjs`, `functions.mjs`, `transports.mjs`, `check/util.mjs` | листья: реестры дескрипторов, ничего не импортируют изнутри рантайма |
| 1 | `expr.mjs`, `spec.mjs` | алгебра выражений и разбор спецификации поля |
| 2 | `blocks.mjs`, `auth.mjs`, `check/scope.mjs`, `check/data.mjs`, `check/steps.mjs`, `check/basics.mjs` | каталог блоков; пароли и сессии; общие помощники чекера |
| 3 | `registry.mjs` | сборка четырёх таблиц + загрузка плагинов |
| 4 | `store.mjs`, `outbox.mjs` | хранилище (SQLite) и исходящий ящик |
| 5 | `check/{roles,override,lists,dashboards,pages,seed,actions,events,states,connectors,rules,plugins}.mjs` | по чекеру на вид узла |
| 6 | `validate.mjs`, `patch.mjs`, `interp.mjs`, `boot.mjs`, `render.mjs` | чекер-драйвер; патч по узлу; интерпретатор шагов (без HTTP); бутстрап identity/seed; каркас рендера |
| 7 | `render/{list,form,detail,dashboard,pages}.mjs` | сами экраны, поверх `render.mjs` |
| 8 | `routes/{context,session,views,system,entity,rows}.mjs` | маршруты, поверх интерпретатора и рендера |
| 9 | `server.mjs` | тонкая HTTP-обвязка: строит контекст запроса, перебирает маршруты |
| 10 | `cli.mjs`, `run.mjs` | точка входа |

`node:` втроенные модули — по отдельной таблице в `tests/arch.test.mjs`: `node:sqlite`
только в `store.mjs`; `node:http` только в `server.mjs`; `fs`/`path` — там же, где сегодня
(`auth.mjs`, `patch.mjs`, `server.mjs`, `cli.mjs`, `routes/context.mjs`, `routes/system.mjs`).

## Кто чем владеет

- **`runtime/check/*.mjs`** — чекер, один модуль на вид узла верхнего уровня плюс
  общие помощники (`util.mjs` — расстояние Левенштейна для подсказок; `scope.mjs` —
  entity/field-lookup, `where`, обе области видимости выражений; `steps.mjs` — обход
  шагов, общий для actions/events/states). `validate.mjs` — драйвер: строит общий
  контейнер `h` (накопитель, `h.err`, `h.fields`, `h.checkEntity`, …) и вызывает
  чекеры в порядке, где более поздние читают то, что раньше записали (`roles.mjs`
  кладёт `h.roleNames`; `override`/`lists`/`dashboards`/`pages`/`states` его читают).
- **`runtime/interp.mjs`** — шаговый интерпретатор: `runSteps`, `resolve`,
  `interpolate`, `fireEvents`, `attempt`/`Refused`, `validateValues`, `writable`.
  Не знает про HTTP: получает `store`/`graph`/`registry`/`perms`/`trace` один раз при
  `serve()` и отдаёт объект функций, которым маршруты и CLI пользуются одинаково.
- **`runtime/boot.mjs`** — то, что происходит один раз при подъёме: identity
  (единственная фейковая текущая строка) и seed (первые строки, топологически по
  ссылкам).
- **`runtime/render.mjs` + `render/*.mjs`** — каркас страницы и общие кирпичики
  (`esc`, `fmt`, `cell`, `rowButtons`, `transitionsFor`) в `render.mjs`; каждый вид
  экрана (list/form/detail/dashboard/статичные страницы, логин, регистрация, outbox)
  — свой файл поверх них.
- **`runtime/routes/*.mjs`** — один файл на группу маршрутов. Контракт: модуль
  экспортирует `handle(ctx) → true | undefined` (обработал / не мой маршрут) —
  `routes/context.mjs` строит `ctx` один раз на запрос (кто спрашивает, `send`/
  `redirect`/`ok`/`deny`, разбор тела, пагинация, CSV). `routes/entity.mjs` —
  терминальный: к моменту, когда до него доходит очередь, `/page`, `/dashboard`,
  `/list`, `/outbox`, `/file`, `/action` уже проверены, так что нерешённый путь —
  либо неизвестная сущность, либо «нет такого маршрута»; он же вызывает
  `routes/rows.mjs` для action/go/add на уже найденной строке.
- **`runtime/server.mjs`** — только подъём: валидирует граф, поднимает `Store`,
  права, сессии, интерпретатор, и на каждый запрос строит контекст и перебирает
  модули маршрутов по порядку. Ни один маршрут не знает про HTTP-подъём; сам
  `server.mjs` не знает про конкретные пути.

## Правило роста

**Новый вид узла = FORMAT.md + чекер + тест.** Правь `docs/FORMAT.md`'s таблицу
«Top-level nodes», добавь модуль в `runtime/check/` с `export const NODES = [...]`
и `check(graph, h)`, и добавь тест, называющий узел по имени — `tests/arch.test.mjs`
проверяет все три условия и валит сборку, если хоть одно пропущено.

Новый блок/тип поля/транспорт/функция — реестр (`registry.mjs`), не вид узла:
растёт каталог, не формат. Контракт обязателен (`tests/arch.test.mjs` проверяет
и встроенные, и плагины из `plugins/` и `apps/*/plugins/`): у блока — `summary`,
`effects`, `requires`, `run`; у типа поля — `sql`, `exprKind`, `def`, `coerce`,
`validate`, `format`, `input`; у транспорта — `summary`, `validate`, `deliver`;
у функции — `arity`, `kind`, `run`.
