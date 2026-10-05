# ⚖️ Dopros Trainer KZ

**AI-тренажёр допроса для Казахстана** — симуляция общения со следователем с разбором каждой ловушки и ссылками на УК/УПК РК.

---

## 📌 Что это

Telegram-бот, который помогает пользователям подготовиться к процессуальным действиям — допросу, даче показаний, общению со следователем. Тренировка проходит в реалистичной форме: AI играет роль следователя, задаёт вопросы, ловит на противоречиях, а после каждого ответа даёт разбор с эталонной формулировкой и ссылками на законодательство РК.

⚠️ **Это не юридическая консультация.** Бот — образовательный инструмент. В реальной ситуации обращайтесь к адвокату.

---

## ✨ Возможности

### 🎭 12 сценариев
| # | Сценарий | Эмодзи |
|---|---|---|
| 1 | Кража в магазине | 🏪 |
| 2 | ДТП | 🚗 |
| 3 | Мошенничество | 💰 |
| 4 | Кража со взломом | 🏠 |
| 5 | Свидетель по чужому делу | 🧑‍⚖️ |
| 6 | Наркотики | 💊 |
| 7 | Криптовалюта | 🪙 |
| 8 | Побои | 🥊 |
| 9 | Изнасилование | ⚠️ |
| 10 | Домашнее насилие | 🏠 |
| 11 | Драка | 👊 |
| 12 | Свой инцидент | 📝 |

### 👤 6 процессуальных статусов
Свидетель · Подозреваемый · Обвиняемый · Потерпевший · Истец · Ответчик

### 🛡️ 8 процессуальных действий
- Право на молчание (ст. 77 Конституции РК)
- Позвать адвоката (ст. 64, 65-1 УПК РК)
- Попросить перерыв (ст. 210 УПК РК)
- Записать замечание (ст. 64 УПК РК)
- Жалоба на давление
- Требовать переводчика
- Отказаться подписывать
- Уточнить вопрос

### 📚 RAG по законам КЗ
Бот использует **локальный RAG** (Retrieval-Augmented Generation):
- Модель `multilingual-e5-small` для embeddings
- 28 статей УК РК, УПК РК, Конституции РК
- Семантический поиск релевантных статей
- Работает **без OpenAI** — всё локально

### 🎓 Умный следователь
Собирательный образ лучших следователей мировой литературы и кино:
- Порфирий Петрович (мягкость, ловля на оговорках)
- Коломбо (прикидывается простаком)
- Жеглов (сухость и жёсткость)
- Эркюль Пуаро (логика и схема)
- Мисс Марпл (простодушие)
- Шерлок Холмс (наблюдательность)
- Гарри Босх (хладнокровие)
- Джек Кроуфорд (чтение людей)
- И другие...

**3 фазы допроса:**
1. **Разогрев** — разговорить, собрать факты
2. **Давление** — поймать на противоречиях
3. **Загон** — вынудить к реакции

### 💰 Оплата
- **Telegram Stars** — 100 XTR
- **USDT** (через CryptoBot) — 2 USDT
- **1 бесплатная тренировка** для новых пользователей

### 🔐 Приватность
- Не собираем ФИО, ИИН, адрес, телефон
- Храним только: Telegram ID, статус оплаты, время обращения
- `/delete_me` — полное удаление данных

---

## 🚀 Быстрый старт (для администратора)

### Требования
- **Node.js 20.x**
- **MongoDB Atlas** (бесплатный tier M0)
- **Telegram Bot Token** (от [@BotFather](https://t.me/BotFather))
- **DeepSeek API Key** (от [platform.deepseek.com](https://platform.deepseek.com))
- **CryptoBot Token** (от [@CryptoBot](https://t.me/CryptoBot)) — для оплаты USDT

### 1. Клонирование

```bash
git clone https://github.com/Heidemann987/virtualdoprosKZ.git
cd virtualdoprosKZ
```

### 2. Установка зависимостей

```bash
npm install
```

### 3. Создание `.env`

Создайте файл `.env` в корне:

```env
# Telegram
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
ADMIN_ID=123456789

# DeepSeek AI
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx

# MongoDB
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/doprosbot

# CryptoPay (опционально)
CRYPTO_PAY_TOKEN=12345:AAxxxxxxxxxxxxxxxxxxxxxx

# Цены
PRICE_STARS=100
PRICE_USDT=2

# Server
PORT=3000

# Webhook (опционально — если не задан, будет polling)
# WEBHOOK_URL=https://your-domain.com
# WEBHOOK_SECRET=random-secret-string
```

### 4. Индексация законов (один раз)

```bash
npm run index-laws
```

Первый запуск скачает модель `multilingual-e5-small` (~120 МБ) и создаст файл `.rag-cache.json`. Займёт 2–4 минуты.

### 5. Запуск

```bash
npm start
```

Или для разработки (с автоперезапуском):

```bash
npm run dev
```

---

## 📁 Структура проекта

```
virtualdoprosKZ/
├── scripts/
│   └── index_laws.js        # Скрипт переиндексации законов
├── .env                     # Переменные окружения (НЕ коммитить!)
├── .env.example             # Шаблон (можно коммитить)
├── .gitignore               # Что игнорировать в git
├── bot.js                   # Основной код бота
├── rag.js                   # RAG-модуль (embeddings + поиск)
├── laws_KZ.json             # База статей КЗ
├── package.json             # Зависимости
├── README.md                # Этот файл
└── LICENSE                  # MIT
```

---

## 🛠 Управление (для админа)

### Команды в боте

| Команда | Описание |
|---|---|
| `/start` | Главное меню / начало тренировки |
| `/admin` | Админ-панель (только для ADMIN_ID) |
| `/help` | Справка |
| `/reset` | Сбросить активную сессию |
| `/finish` | Завершить тренировку и получить итог |
| `/privacy` | Политика конфиденциальности |
| `/delete_me` | Удалить свои данные |
| `/cancel` | Отменить текущее действие |

### Админ-панель

Отправьте `/admin` — увидите:

- 📊 **Статистика** — пользователи, конверсия, доходы
- 📅 **Динамика** — новые за 24ч / 7д / 30д
- 💰 **Доходы** — Stars и USDT отдельно, за сегодня
- 👥 **Пользователи** — фильтры: новые, платные, пробные, активные
- 💰 **Платежи** — последние 15 транзакций
- 📊 **Топ сценариев** — рейтинг пользователей по сессиям
- ❌ **Ошибки** — последние 10 с возможностью очистки
- 💬 **Сообщения** — непрочитанные обращения + ответ
- 📢 **Рассылка** — всем / платным / пробным
- 🎁 **Выдать доступ** — вручную по ID
- 🚫 **Забанить** — по ID
- 📤 **Экспорт CSV** — выгрузка всех пользователей

---

## 🌐 Деплой

### Вариант 1: Railway (рекомендую)

1. Создайте аккаунт на [railway.app](https://railway.app)
2. **New Project** → **Deploy from GitHub repo**
3. Выберите `virtualdoprosKZ`
4. **Variables** — добавьте все переменные из `.env`
5. Railway сам запустит `npm start`
6. **Settings → Domains** → сгенерировать домен
7. Добавьте `WEBHOOK_URL` (ваш домен) → Railway перезапустит бота на webhook

⚠️ **Первый деплой**: после запуска Railway выполнит `npm install`, но **не** `index-laws`. Нужно:
- Открыть **Shell** в Railway → `npm run index-laws` (один раз)
- Или **не удалять** `.rag-cache.json` из git (но тогда ~15 МБ в репо)

### Вариант 2: Render

1. [render.com](https://render.com) → **New Web Service**
2. Подключите GitHub-репозиторий
3. **Build Command**: `npm install`
4. **Start Command**: `npm start`
5. **Environment** — добавьте переменные

### Вариант 3: VPS (полный контроль)

```bash
# Ubuntu 22.04
sudo apt update && sudo apt install -y nodejs npm git
git clone https://github.com/Heidemann987/virtualdoprosKZ.git
cd virtualdoprosKZ
npm install
npm run index-laws
# Создайте .env с переменными
npm start

# Для работы 24/7 — pm2
sudo npm install -g pm2
pm2 start bot.js --name doprosbot
pm2 save
pm2 startup
```

---

## 🔧 Технологии

| Компонент | Технология |
|---|---|
| Bot framework | [grammY](https://grammy.dev) 1.30 |
| AI | [DeepSeek](https://deepseek.com) `deepseek-chat` |
| Embeddings | [@xenova/transformers](https://github.com/xenova/transformers.js) `multilingual-e5-small` |
| База данных | [MongoDB](https://mongodb.com) 6.5 |
| Оплата | Telegram Stars + [CryptoBot](https://t.me/CryptoBot) |
| Server | [Express](https://expressjs.com) 4.19 |
| Node.js | 20.x LTS |

---

## 📊 Стоимость эксплуатации

| Услуга | Цена |
|---|---|
| MongoDB Atlas M0 | **Бесплатно** |
| Railway / Render | **Бесплатно** (с лимитами) |
| DeepSeek API | ~$0.14 / 1M токенов (в 10 раз дешевле GPT-4) |
| Embeddings | **Бесплатно** (локальная модель) |
| Telegram Stars | Комиссия Telegram |

**Примерно $1–3/месяц** при небольшой нагрузке.

---

## 🐛 Решение проблем

### `Cannot find module '@xenova/transformers'`
```bash
npm install @xenova/transformers
```

### `MONGODB_URI missing`
Не создан `.env`. Проверьте, что файл существует в корне.

### `bad auth : authentication failed`
Неверный пароль в `MONGODB_URI`. В MongoDB Atlas:
**Database Access** → ваш user → **Edit Password** → создать новый.

### `Error: 401 Unauthorized`
Неверный `DEEPSEEK_API_KEY`. Проверьте на [platform.deepseek.com](https://platform.deepseek.com).

### `setWebhook failed`
Неверный `WEBHOOK_URL`. Уберите переменную — бот упадёт в polling.

### Медленно при первом запуске
Загружается модель embeddings (~120 МБ). Последующие запуски — 2–3 секунды.

---

## 📝 Лицензия

MIT — см. [LICENSE](LICENSE).

---

## 📞 Контакты

- **Разработчик:** [@Heidemann987](https://github.com/Heidemann987)
- **Бот:** [@ваш_бот](https://t.me/ваш_бот)
- **Поддержка:** через бота → «💬 Написать админу»

---

⚠️ **Дисклеймер:** бот является образовательным тренажёром и **не заменяет** юридическую консультацию. В реальной процессуальной ситуации обращайтесь к квалифицированному адвокату.# virtualdoprosKZ
