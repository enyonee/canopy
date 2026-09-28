# Архитектура рантайма

Гейты (`tests/arch.test.mjs`) держат это в силе автоматически: слои, бюджеты строк,
реестр видов узлов — всё описанное ниже проверяется, а не только документируется.

## Слои

Снизу вверх; модуль импортирует только то, что явно перечислено в
`tests/arch.test.mjs`'s `ALLOWED` (циклов нет, реестр импортов вынесен из прозы в тест).

| слой | модули | зачем |
|---|---|---|
| 0 | `fields.mjs`, `functions.mjs`, `transports.mjs`, `widgets.mjs`, `schedule.mjs`, `check/util.mjs`, `client/api.mjs`, `driver/sqlite.mjs` | листья: реестры дескрипторов и форматы, ничего не импортируют изнутри рантайма; `client/api.mjs` — единственный файл, который *исполняется* в браузере, а не сервером (см. «Клиентские виджеты») |
| 1 | `expr.mjs`, `spec.mjs`, `driver.mjs` | алгебра выражений и разбор спецификации поля; `driver.mjs` — `open(fileOrDriver)`, выбор драйвера хранилища |
| 2 | `blocks.mjs`, `auth.mjs`, `check/scope.mjs`, `check/data.mjs`, `check/steps.mjs`, `check/basics.mjs` | каталог блоков; пароли и сессии; общие помощники чекера |
| 3 | `registry.mjs` | сборка пяти таблиц (плюс `widgets`) + загрузка плагинов |
| 4 | `store.mjs`, `outbox.mjs` | хранилище (говорит с базой только через `this.drv`) и исходящий ящик |
| 5 | `check/{roles,override,lists,dashboards,pages,seed,actions,events,states,schedule,connectors,rules,plugins,search}.mjs` | по чекеру на вид узла (плюс `checkWidget` в `check/util.mjs`, общий для `pages.mjs`/`override.mjs`) |
| 6 | `validate.mjs`, `patch.mjs`, `interp.mjs`, `boot.mjs`, `render.mjs` | чекер-драйвер; патч по узлу; интерпретатор шагов (без HTTP); бутстрап identity/seed (плюс сидируемые файлы, раунд 5); каркас рендера (плюс `rowJSON`/`widgetBlock`/`mayRunAction`) |
| 7 | `render/{list,form,detail,dashboard,pages,search}.mjs` | сами экраны, поверх `render.mjs` (`dashboard.mjs` — и графики; `search.mjs` — раунд 5) |
| 8 | `routes/{context,session,views,system,entity,rows,widgets,schedule}.mjs` | маршруты, поверх интерпретатора и рендера |
| 9 | `server.mjs` | тонкая HTTP-обвязка: строит контекст запроса, перебирает маршруты, заводит таймеры расписаний |
| 10 | `cli.mjs`, `run.mjs` | точка входа |

`node:` втроенные модули — по отдельной таблице в `tests/arch.test.mjs`: `node:sqlite`
только в `driver/sqlite.mjs`; `node:http` только в `server.mjs`; `node:fs` также в `routes/widgets.mjs`
(читает файл виджета, который назвал плагин) и в `boot.mjs` (копирует сидируемый файл в
`files/`, раунд 5); `fs`/`path` — там же, где сегодня
(`auth.mjs`, `patch.mjs`, `server.mjs`, `cli.mjs`, `routes/context.mjs`, `routes/system.mjs`, `boot.mjs`).

## Кто чем владеет

- **`runtime/store.mjs` + `runtime/store/*.mjs`** (раунд 7, 8, 9) — `query.mjs`:
  чтение и структурные запросы (`listRaw`/`listPage`/`aggregate`/…); `migrate.mjs`:
  индексы, выводимые из графа (`ref`-поля, `rules.unique`, статусное поле `states`,
  best-effort по `where` сохранённых списков/панелей) — создаются и удаляются как
  колонки, идемпотентно.
  **S1, шов драйвера** (`docs/POSTGRES.md`) — `runtime/driver/sqlite.mjs`: единственное
  место, где живут `node:sqlite`, `PRAGMA`, `sqlite_master`, `AUTOINCREMENT` и
  `.prepare(`. Контракт `Driver` (`runtime/types.d.ts`): `all/get/run(sql, params)`
  (`run` → `{ changes, lastId }`), `exec`, `transaction(fn)`, `close`, `dialect`
  (`name`, `quote`), схема (`tables/columns/indexes`, `createTable/addColumn/createIndex/
  dropIndex`), хук `onQuery(sql, opts)` (счёт запросов в `perf.test.mjs`). Внутри —
  bounded LRU кэш подготовленных запросов (`cache`, 200 записей; `{ cache: false }` — для
  IN-списков, чей текст почти не повторяется). `Store` держит драйвер в `this.drv`
  (4-й аргумент конструктора — свой драйвер), всё остальное в `store/` ходит только через
  него; пока синхронно, ничего не `await`-ится.
  **Раунд 11, ящик** — `state.mjs`: `outboxClaim(id, now, leaseMs)` — один
  `UPDATE ... WHERE id=? AND (status='queued' OR (status='sending' AND claimedAt<=now-lease))`,
  истина только если изменилась ровно одна строка; `outboxDue` — кандидаты.
  `outbox.mjs#flush` доставляет лишь то, что сам захватил (статусы
  `queued → sending → sent|failed`); строка, застрявшая в `sending` дольше
  `LEASE_MS` (60 с, часы внедряются через `opts.now`), захватывается снова —
  доставка ровно один раз, а при падении процесса — минимум один раз, поэтому
  коннектору нужен ключ идемпотентности. Итоговая запись доставки из `flush` —
  `outboxFinish(id, claimedAt, patch)`: `UPDATE ... WHERE id=? AND claimedAt=? AND status='sending'`;
  проигравшая аренду медленная доставка отбрасывается и трассируется
  (`kind:'delivery', stale:true`, результат `'stale'`), не ошибка. Ручные пути
  (`/outbox/:id/retry`, вызов `deliver` без `claimedAt`) пишут через `outboxUpdate`. Колонка `claimedAt` (epoch мс) добавляется
  `migrate.mjs#migrateOutbox` на месте, в старых базах тоже.
  **Раунд 8–9, батчинг и агрегаты** — `hydrate.mjs`: `hydratePage`/`buildAggCache`/
  `aggValue`. Для каждого агрегатного производного поля прямо на сущности сперва
  пробуется `aggsql.mjs`'s `compileAgg` (входная точка, запуск, кэш планов; сам
  компилятор выражений — `aggexpr.mjs`): count/sum/avg/min/max с прямым `via`,
  тело (или условие count) которого построено из
  - хранимых `int`/`money`/`bool`/`date`/`time` полей ребёнка, целых литералов и
    ISO-литералов даты/времени, `today`/`now`, арифметики `+ - *`, сравнений,
    `and/or/not`, `if(...)`;
  - **производных скалярных полей ребёнка** (раунд 9) — выражение инлайнится, если
    поле на выходе точно int/money/bool/date/time (money*money и int из money
    отклоняются: там нужно настоящее округление до копеек);
  - **производных или вписанных агрегатов над внуком** (раунд 9) —
    коррелированный скалярный подзапрос (`Customer.spent := sum(Order: total)`,
    `total := sum(Item: qty * price)`): `COALESCE(…, 0)` для sum/count, NULL для
    min/max пустой группы, `avg` внутри — не компилируется (дробь); join по
    `CAST(id AS TEXT)`, иначе индекс TEXT-колонки ссылки не используется.

  Компилируется — один SQL-запрос на всю страницу родителей (`runAggBatch`,
  `GROUP BY via`) или один на одиночную строку (`runAggOne`, `Store#get()`) —
  **ни одна строка ребёнка не попадает в JS**, только готовое число в
  `cache.scalars`. `min`/`max` по date/time отвечают сохранённым текстом, как
  `expr.mjs`. Не компилируется (`row.*`, хоп через ссылку, плагин-функция, деление,
  дробный литерал, текст/enum/ref, внутренний `avg`, производное money*money,
  вложенный min/max над сырым произведением денег, рекурсия глубже границ) —
  прежний путь: `listRawIn` в `cache.groups`, рекурсия в дочернюю сущность (та же
  рекурсия обнаруживает, что вложенный агрегат следующего уровня зачастую
  компилируется). `ctx().rows()` и `ctx().agg()` (`store/ctx.mjs`'s `RowCtx` —
  класс, не объект из замыканий, раунд 9, item 5) прозрачно берут из кэша, когда он
  есть, и иначе идут в базу как раньше — корректность не зависит от того, попал ли
  конкретный агрегат под батчинг или под компиляцию.

  Точность SQL-пути: всё целочисленно в своём масштабе (деньги — минорные единицы,
  scale 100) до самого последнего деления, которое раз на родителя проходит через
  тот же `exact()`, что и `expr.mjs`'s sum/avg; масштаб выше 1e6 (столько знаков
  `exact()` оставляет) не компилируется. Известное расхождение, доставшееся от
  0.1.2 и оставленное как есть: сравнение *сырого* произведения денег с точно
  равным значением (`qty * price > disc` при 3, 0.1, 0.3) SQL считает десятичным,
  JS — двойным (0.30000000000000004); новые формы его не расширяют — раздел
  «Раунд 9» в TESTS.md. Компиляция ограничена (стек производных, глубина
  подзапросов, бюджет расширений на один план), цикл производных не
  компилируется и не зацикливает компилятор; целое за пределами SQLite/JS
  (переполнение `SUM`, значение > 2^53) откатывает *этот* агрегат на JS-путь при
  исполнении, любая другая SQL-ошибка остаётся ошибкой.

  **Часы.** Одно вычисление — одни часы: `Store#derived` читает `new Date()` один
  раз (или берёт `cache.clock` страницы) и передаёт его `RowCtx` → вложенным
  производным полям, хопам и дочерним строкам; `evaluate()` передаёт тот же
  clock в `ctx.agg(node, clock)`, и `today`/`now` внутри компилируемого тела
  связываются именованными параметрами `$today`/`$now` из него — не часами SQLite.

  Память (раунд 8, item 2; раунд 9, item 5): `hydratePage` режет страницу на чанки
  по 500 родителей — кэш и сырые строки детей живут на чанк, а не на весь запрос.
  Оставшийся рост RSS после тяжёлых запросов — не удержание (живых ~8 МБ), а выросшая
  молодая генерация V8 от числа аллокаций на строку; поэтому `RowCtx` — класс
  (три замыкания на каждое производное поле каждой строки), а ключ агрегата
  считается один раз вместе с планом.
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
  `redirect`/`ok`/`deny`/`sendJson`/`answer`, разбор тела, пагинация, CSV;
  `wantsJSON` — `accept: application/json` — решает HTML или JSON один раз и
  только там, где маршрут и так уже отвечал). `routes/entity.mjs` —
  терминальный: к моменту, когда до него доходит очередь, `/page`, `/dashboard`,
  `/list`, `/outbox`, `/file`, `/action`, `/widget`, `/schedule` уже проверены,
  так что нерешённый путь — либо неизвестная сущность, либо «нет такого
  маршрута»; он же вызывает `routes/rows.mjs` для action/go/add на уже
  найденной строке. `routes/widgets.mjs` отдаёт `/widget/<name>.mjs` (файл,
  который назвал плагин) и общий `/widget/_api.mjs`; `routes/schedule.mjs` —
  ручной запуск `POST /schedule/<name>/run`, той же проверкой, что и `/outbox`.
- **`runtime/server.mjs`** — только подъём: валидирует граф, поднимает `Store`,
  права, сессии, интерпретатор, заводит таймеры расписаний (`schedule.mjs`'s
  `everyMs`, отключаемо `noTimers`), и на каждый запрос строит контекст и
  перебирает модули маршрутов по порядку. Ни один маршрут не знает про
  HTTP-подъём; сам `server.mjs` не знает про конкретные пути.

## Правило роста

**Новый вид узла = FORMAT.md + чекер + тест.** Правь `docs/FORMAT.md`'s таблицу
«Top-level nodes», добавь модуль в `runtime/check/` с `export const NODES = [...]`
и `check(graph, h)`, и добавь тест, называющий узел по имени — `tests/arch.test.mjs`
проверяет все три условия и валит сборку, если хоть одно пропущено.

Новый блок/тип поля/транспорт/функция/виджет — реестр (`registry.mjs`), не вид узла:
растёт каталог, не формат. Контракт обязателен (`tests/arch.test.mjs` проверяет
и встроенные, и плагины из `plugins/` и `apps/*/plugins/`): у блока — `summary`,
`effects`, `requires`, `run`; у типа поля — `sql`, `exprKind`, `def`, `coerce`,
`validate`, `format`, `input`; у транспорта — `summary`, `validate`, `deliver`;
у функции — `arity`, `kind`, `run`; у виджета — `summary`, `client` (`props`,
`check` необязательны). Виджет привязывается к узлу (`pages[].widget`,
`"Entity.detail".widget`) — это свойство существующих видов узлов, а не новый
вид: `checkWidget` в `check/util.mjs` — общий код для `check/pages.mjs` и
`check/override.mjs`, а не отдельный чекер.
