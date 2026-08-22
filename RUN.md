# Как запустить срез

```bash
node runtime/run.mjs apps/todo/app.json --check          # проверить граф
node runtime/run.mjs apps/todo/app.json --port 8901      # поднять приложение
node verify/todo.mjs                                     # приёмочные проверки
node runtime/patch.mjs apps/todo/app.json apps/todo/change-1-priority.patch.json  # правка патчем
```

Требуется Node 22+ (используется встроенный `node:sqlite`). Зависимостей нет.
Приложение — это каталог: `app.json`, `data.sqlite`, `trace.jsonl`.
