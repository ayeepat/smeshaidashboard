# СМЭШ AI operations dashboard

Внутренняя статическая панель аналитики и управления AI gateway. Сборки нет:
index.html, styles.css и app.js публикуются на GitHub Pages.

Production URL: https://ayeepat.github.io/smeshaidashboard/

## Два независимых доступа

- STATS_SECRET передаётся как X-Stats-Token к
  https://smeshapi.site/admin/stats/*. Это read-only доступ к агрегатам и
  операционным очередям; он не может выдавать, отзывать или менять лицензии.
- MODEL_ADMIN_KEY передаётся как X-Model-Admin-Key к
  https://ai.smeshapi.site/admin/model-config. Он меняет только маршруты,
  лимиты, processor register и feature switches.

Эти ключи должны быть разными и не совпадать с ADMIN_SECRET, INGEST_KEY,
ENTITLEMENT_SECRET или ключом 302.AI. Оба dashboard-ключа хранятся только в
памяти JavaScript текущей вкладки и исчезают после закрытия или обновления.
При загрузке панель удаляет legacy-копии этих секретов из localStorage и
sessionStorage. Это важно на GitHub Pages: Web Storage привязан ко всему origin
`https://ayeepat.github.io`, а не к каталогу `/smeshaidashboard/`.

VPS допускает model API только с точного MODEL_DASHBOARD_ORIGIN и отклоняет
устаревшую expected_revision с HTTP 409.

## Аналитика

Панель показывает:

- выручку, возвраты, покупки, средний чек и платежные шлюзы;
- DAU/WAU/MAU, устройства, браузеры и типы лицензий;
- использования функций, предметы, retention и когорты;
- фактические server-observed AI-вызовы, токены и оценочную стоимость;
- маржу платных пользователей;
- подписки, checkout funnel и непродления;
- обращения, отзывы, ошибки и операторские worklists.

Платёжные данные и worklists полны, потому что создаются сервером. Продуктовая
аналитика является выборкой: телеметрия в расширении выключена по умолчанию и
VPS отправляет content-free usage event только при отдельном opt-in. Панель не
должна представлять такую выборку как всех пользователей.

Текст заданий, ответы, файлы, journal session token, raw license key и
activation token не являются полями аналитики и не должны появляться в UI,
логах или экспортах.

## Управление AI

Раздел «Модели ИИ» управляет одним versioned JSON-документом. Сохранение
атомарно применяется ко всем новым запросам; активный job сохраняет свой
routing snapshot. Доступен rollback последних десяти ревизий.

### Что стоит по умолчанию

Всё, кроме PDF, идёт через одну модель — `qwen3.8-flash` — на всех трёх
цепочках: Auto, Think и Standard. Она мультимодальная, поэтому текст и
картинки на одном id; `qwen3.7-plus` и `qwen-vl-plus` остаются fallback'ами.
PDF живут отдельно на `gemini-2.5-flash-lite`.

Усилие рассуждения VPS ставит **по имени модели**, а не по галочке в панели:

| модель | что уходит на 302.AI |
| --- | --- |
| `qwen3.8-flash` | `reasoning_effort` в словаре Qwen: `low` / `medium` / `xhigh` (никакого `high`). МЭШ-домашка и тесты — всегда `xhigh`; понизить может только запрос с `tier: standard`, и его хинт при этом переводится. |
| `qwen*` старше 3.8 | ничего: эти модели думают по умолчанию и не имеют уровней усилия. |
| `glm-5.3-flash` | `thinking: {type:"enabled"}` + `reasoning_effort: "max"`. |
| всё остальное | клиентский `reasoning_effort`, если у route включена галочка. |

Поэтому галочка «Передавать `reasoning_effort`» влияет только на модели, о
которых VPS не знает по имени. На дешёвой цепочке её лучше держать выключенной:
туда переливается и МЭШ-домашка, которая не должна думать мельче из-за
клиентской подсказки «подешевле».

Если 302.AI вернёт `err_code: -10003` на модель, которой политика шлёт
`reasoning_effort`, VPS повторит запрос той же моделью без этого поля —
ответ станет менее глубоким, но маршрут не умрёт. Поддержку поля у конкретной
модели проверяет `API_302_KEY=… bash tests/302ai-verify.sh` в основном репо.

Управляемые параметры:

- цепочки Auto, Think, Standard и PDF;
- общий минутный лимит, frontier/standard/global daily limits и force_standard;
- цены моделей для оценки затрат;
- server-side processors allowlist;
- восемь независимых switches:
  ai_text, ai_images, ai_documents, mesh_attachments, autofill, other_sites,
  telemetry и gdz.

Каждая модель в любой цепочке обязана иметь processor record:

~~~json
{
  "model-id": {
    "display_name": "Публичное название",
    "operator": "Юридический/сервисный оператор",
    "privacy_url": "https://provider.example/privacy",
    "enabled": true
  }
}
~~~

Не зарегистрированную или выключенную модель VPS не сохранит и не запустит.
Публичный endpoint https://ai.smeshapi.site/processors возвращает тот же реестр
без секретов; страница https://smeshai.xyz/processors/ отображает его
пользователям.

Feature switches независимы. AI text/images/documents дополнительно
enforce-ятся на VPS. Extension получает все восемь switches через подписанный
P-256 endpoint /public/runtime-config; неподписанный, просроченный или
неизвестный config отклоняется.

## Безопасная смена модели

Перед сохранением:

1. Проверить, что модель доступна через используемый 302.AI endpoint.
2. Проверить поддержку text/vision/PDF для соответствующей цепочки.
3. Проверить условия обработки, retention, возрастные ограничения и страны.
4. Добавить точного оператора и HTTPS privacy URL в processor record.
5. Убедиться, что публичный /processors отражает ожидаемый набор.
6. После сохранения выполнить один synthetic запрос без пользовательских данных.

Для школьной аудитории не включать Gemini API без отдельного письменного
подтверждения допустимости: актуальные Gemini API Terms запрещают API clients,
ориентированные на лиц младше 18 лет или вероятно доступные им.
Dashboard и VPS отклоняют Gemini в любой активной цепочке. `ai_documents` по
умолчанию выключен, а Gemini processor records — disabled. Исключение на VPS
возможно только после документированного письменного разрешения поставщика;
обычная галочка пользователя его не заменяет.

## Первичная настройка VPS

Сгенерировать отдельный model key:

~~~sh
openssl rand -hex 32
~~~

В /etc/smesh-proxy.env установить MODEL_ADMIN_KEY и
MODEL_DASHBOARD_ORIGIN=https://ayeepat.github.io, затем перезапустить сервис и
проверить /ready. Секрет не добавлять в репозиторий.

## Локальный запуск

~~~sh
python3 -m http.server 4599
~~~

Открыть http://127.0.0.1:4599. Для локального управления моделями временно
указать MODEL_DASHBOARD_ORIGIN=http://127.0.0.1:4599 на VPS, а перед production
deploy вернуть GitHub Pages origin.

API_BASE и MODEL_API_BASE находятся в начале app.js. После изменения
протокола одновременно обновить therealmesh/backend-vps/server.js, тесты,
публичный processor register и compliance/data-flows.json.
