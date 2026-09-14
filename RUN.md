# Как запустить

```bash
node runtime/run.mjs apps/shop/app.json --check     # проверить граф
node runtime/run.mjs apps/shop/app.json --port 8901 # поднять приложение (admin@shop.test / admin123)
node verify/run.mjs                                 # приёмочные проверки всех приложений + изменения патчами
node verify/run.mjs shop crm                        # только выбранные
node --test 'tests/*.test.mjs'                      # тесты рантайма (см. TESTS.md)
node tests/mutate.mjs                               # мутационный гейт
node runtime/patch.mjs apps/shop/app.json apps/shop/change-1-role.patch.json  # правка патчем
```

Требуется Node 22+ (используется встроенный `node:sqlite`). Зависимостей нет.
Приложение — это каталог: `app.json`, `data.sqlite`, `trace.jsonl`, `session.key` (если есть
роли), `files/` (если есть поля-файлы). Справочник формата — `docs/FORMAT.md`.

`verify/run.mjs` поднимает локальный приёмник исходящих HTTP на порту 8999 (графы шлют
вебхуки на `http://127.0.0.1:8999/...`) и приложения с порта 8910. Несколько прогонов на одной
машине разводятся переменными `AG_SINK_PORT` и `AG_PORT`.
