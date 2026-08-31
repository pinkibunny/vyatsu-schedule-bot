# Бот расписания БТб-3101-03-00

Telegram-бот для расписания группы БТб-3101-03-00 Института биологии и
биотехнологии ВятГУ. Он автоматически находит свежую двухнедельку на официальной
странице, разбирает Excel-PDF без OCR и показывает занятия по дням и неделям.

## Что уже умеет

- «Сегодня», «Завтра», «Эта неделя» и «Следующая неделя».
- Фильтр первой, второй или обеих подгрупп.
- Корректная обработка нескольких занятий внутри одной ячейки.
- Отдельное отображение вариантов физкультурных секций.
- Автоматическая проверка официальной страницы каждый час.
- Сохранение последнего рабочего JSON, если сайт ВятГУ временно недоступен.
- Защищённый Telegram webhook: запросы проверяются по секретному заголовку.

## Как всё устроено

1. GitHub Actions каждый час запускает Python-парсер.
2. Парсер находит актуальную ссылку группы на странице ВятГУ, скачивает PDF и
   обновляет `data/schedule.json` только при реальных изменениях.
3. Cloudflare Worker получает сообщения Telegram через webhook, читает готовый
   JSON и форматирует ответ. Постоянный сервер и база данных не нужны.

Токен бота нигде в репозитории не хранится. Он добавляется в секреты Worker.

## Локальная проверка парсера

Нужен Python 3.11 или новее.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e '.[test]'
pytest -q
python scripts/update_schedule.py --output data/schedule.json
```

В Windows PowerShell активация окружения выглядит так:

```powershell
.venv\Scripts\Activate.ps1
```

## Развёртывание

### 1. Создать Telegram-бота

1. Открыть в Telegram `@BotFather`.
2. Выполнить `/newbot`, задать имя и username.
3. Сохранить выданный токен локально. Не публиковать его и не коммитить.

### 2. Загрузить проект на GitHub

Проект настроен для публичного репозитория
[`pinkibunny/vyatsu-schedule-bot`](https://github.com/pinkibunny/vyatsu-schedule-bot).
Публичность нужна только для чтения `data/schedule.json`; само расписание уже
опубликовано ВятГУ. Токена Telegram в репозитории нет.

В настройках репозитория открыть `Settings → Actions → General → Workflow
permissions` и включить `Read and write permissions`. Затем вручную запустить
`Actions → Update schedule → Run workflow` и проверить успешное выполнение.

### 3. Проверить ссылку на JSON

В `worker/wrangler.jsonc` уже указана ссылка:

```text
https://raw.githubusercontent.com/pinkibunny/vyatsu-schedule-bot/main/data/schedule.json
```

### 4. Развернуть Cloudflare Worker

Нужны Node.js 20+ и бесплатный аккаунт Cloudflare.

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler deploy
```

Обе команды `secret put` запросят значение скрытым вводом. Для
`WEBHOOK_SECRET` удобно сгенерировать случайную строку:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Сохранить эту строку до следующего шага. После deploy Wrangler покажет адрес
вида `https://vyatsu-schedule-bot....workers.dev`.

### 5. Подключить webhook

Из корня проекта запустить:

```bash
python scripts/set_webhook.py https://АДРЕС-WORKER.workers.dev
```

Скрипт скрыто запросит `BOT_TOKEN` и тот же `WEBHOOK_SECRET`, добавит команды
бота и зарегистрирует webhook. После этого в Telegram достаточно выполнить
`/start`.

## Обновление расписания

GitHub Actions запускает парсер на 17-й минуте каждого часа. Если PDF или его
ссылка изменились, новый JSON автоматически коммитится. Если данных нет или
структура PDF неожиданно изменилась, workflow завершится ошибкой, а бот
продолжит использовать последнюю исправную версию.

## Источники

- Страница расписания: <https://www.vyatsu.ru/studentu-1/spravochnaya-informatsiya/raspisanie-zanyatiy-dlya-studentov.html>
- Группа: `БТб-3101-03-00`
- Текущий внутренний ID группы: `26729`
