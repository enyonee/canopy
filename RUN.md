# Как запустить

```bash
npm ci                                              # runtime and development dependencies
node runtime/run.mjs apps/shop/app.json --check     # проверить граф
node runtime/run.mjs apps/shop/app.json --port 8901 # поднять приложение (admin@shop.test / admin123)
node verify/run.mjs                                 # приёмочные проверки всех приложений + изменения патчами
node verify/run.mjs shop crm                        # только выбранные
node --test 'tests/*.test.mjs'                      # тесты рантайма (см. TESTS.md)
node runtime/patch.mjs apps/shop/app.json apps/shop/change-1-role.patch.json  # правка патчем
```

Требуется Node 22+ (используется встроенный `node:sqlite`). Для запуска без
инструментов разработки используйте `npm ci --omit=dev`.
Приложение — это каталог: `app.json`, `data.sqlite`, `trace.jsonl`, `session.key` (если есть
роли), `files/` (если есть поля-файлы). Справочник формата — `docs/FORMAT.md`.

`verify/run.mjs` поднимает локальный приёмник исходящих HTTP на порту 8999 (графы шлют
вебхуки на `http://127.0.0.1:8999/...`) и приложения с порта 8910. Несколько прогонов на одной
машине разводятся переменными `AG_SINK_PORT` и `AG_PORT`.

## Сгенерированный фронт (webgen)

Приложение с `"web": "web/dist"` отдаёт собранный фронт на `/`, стенд уходит под `/admin`.
Фронт — вывод генератора, правят граф и шаблон, а не каталог `web/`.

```bash
cd webgen && npm ci && cd ..
node runtime/run.mjs apps/crm/app.json --openapi --out apps/crm/web/openapi.json   # контракт приложения
node webgen/gen.mjs apps/crm/app.json --openapi apps/crm/web/openapi.json --out apps/crm/web
npm --prefix apps/crm/web install && npm --prefix apps/crm/web run build           # dist/ коммитится
node runtime/run.mjs apps/crm/app.json --port 8902                                # админ: admin@crm.test / admin123
```

Сверки: `node webgen/gen.mjs … --check` (дрейф генерации), `node webgen/check-contract.mjs apps/crm/app.json`
(контракт, типы и файлы против рантайма), `npm --prefix webgen test`.
