# agri — webgen-bench/000065

## Weakened cases

- **Case 3 (local weather forecast for the user's detected location).** There is no geolocation
  and no external weather API/connector in the runtime, so the forecast is five seeded
  `WeatherReading` rows for one fixed named region, "Green Valley County" — stated here rather
  than invented as a live/detected reading. The check asserts the seeded rows and their order,
  not a real forecast.

## Misses

- `connector` — no geolocation input and no weather-data connector; `WeatherReading` is plain
  seeded data, refreshed by hand like every other seeded row, not polled from a service.
- `node kind` — the ui_instruct's "up-to-date weather conditions" implies a live-refreshing
  widget; the closest honest reading here is a static list of forecast rows.

## New for this app

- A pure read-only content site with a single `admin` role and no `register`: every visible
  entity (`NewsArticle`, `FarmProduct`, `WeatherReading`) is guest-`view`-only and `create: false`
  on every list, so the only way to add content is as the admin — the same shape as the
  reference `shipnews` app, applied to a different subject.
- Three independent list filters/searches on three unrelated entities in one graph (news search +
  category filter, product search + category/availability filters, weather with no filter at
  all — a forecast is browsed whole).
