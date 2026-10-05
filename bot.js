// ═══════════════════════════════════════════════════════════════
// bot.js — Dopros Trainer KZ v12
// ЧАСТЬ 1/6 — Конфиг + БД + Константы + Утилиты
// ═══════════════════════════════════════════════════════════════
const { Bot, InlineKeyboard, Keyboard, InputFile } = require('grammy');
const OpenAI = require('openai');
const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { MongoClient, ObjectId } = require('mongodb');
const { initRAG, findRelevantArticles } = require('./rag');

// ═══════════ КОНФИГ ═══════════
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = 'deepseek-chat';
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '0');
const CRYPTO_PAY_TOKEN = process.env.CRYPTO_PAY_TOKEN;
const PRICE_STARS = parseInt(process.env.PRICE_STARS || '100');
const PRICE_USDT = parseInt(process.env.PRICE_USDT || '2');
const PORT = parseInt(process.env.PORT || '3000');
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'dopros-secret';

// ═══════════ ВАЛИДАЦИЯ ═══════════
if (!BOT_TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN missing'); process.exit(1); }
if (!DEEPSEEK_KEY) { console.error('❌ DEEPSEEK_API_KEY missing'); process.exit(1); }
if (!MONGODB_URI) { console.error('❌ MONGODB_URI missing'); process.exit(1); }
if (!ADMIN_ID) { console.error('❌ ADMIN_ID missing'); process.exit(1); }
if (!CRYPTO_PAY_TOKEN) console.warn('⚠️ CRYPTO_PAY_TOKEN missing — USDT недоступен');

const ai = new OpenAI({ apiKey: DEEPSEEK_KEY, baseURL: 'https://api.deepseek.com' });

// ═══════════ БД ═══════════
let db, usersCol, paymentsCol, errorsCol, messagesCol;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('doprosbot');
  usersCol = db.collection('users');
  paymentsCol = db.collection('payments');
  errorsCol = db.collection('errors');
  messagesCol = db.collection('messages');
  await usersCol.createIndex({ userId: 1 }, { unique: true });
  await messagesCol.createIndex({ createdAt: -1 });
  await errorsCol.createIndex({ createdAt: -1 });
  console.log('✅ MongoDB connected');
}

async function getUser(userId, from = null) {
  let u = await usersCol.findOne({ userId });
  if (!u) {
    u = {
      userId,
      username: from?.username || null,
      firstName: from?.first_name || null,
      paid: false, paidAt: null, paymentMethod: null,
      trialUsed: false, trialUsedAt: null,
      sessions: 0, lastSeen: new Date(), createdAt: new Date(),
      banned: false
    };
    await usersCol.insertOne(u);
  } else {
    await usersCol.updateOne({ userId }, {
      $set: {
        lastSeen: new Date(),
        username: from?.username || u.username,
        firstName: from?.first_name || u.firstName
      }
    });
  }
  return u;
}

async function setUserPaid(userId, method) {
  await usersCol.updateOne({ userId }, {
    $set: { paid: true, paidAt: new Date(), paymentMethod: method }
  });
}

async function markTrialUsed(userId) {
  await usersCol.updateOne({ userId }, {
    $set: { trialUsed: true, trialUsedAt: new Date() }
  });
}

async function logError(err, userId) {
  try {
    await errorsCol.insertOne({
      message: err.message || String(err),
      stack: err.stack || null,
      userId: userId || null,
      createdAt: new Date()
    });
  } catch (e) { console.error('logError failed:', e.message); }
}

async function saveMessage(fromUserId, text) {
  const r = await messagesCol.insertOne({
    fromUserId, text, direction: 'to_admin',
    replied: false, createdAt: new Date()
  });
  return r.insertedId;
}

// ═══════════ CRYPTO PAY ═══════════
const CRYPTO_PAY_API = 'https://pay.crypt.bot/api';

async function createUsdtInvoice(userId) {
  if (!CRYPTO_PAY_TOKEN) throw new Error('CryptoPay не настроен');
  const res = await fetch(`${CRYPTO_PAY_API}/createInvoice`, {
    method: 'POST',
    headers: {
      'Crypto-Pay-API-Token': CRYPTO_PAY_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      currency_type: 'crypto',
      asset: 'USDT',
      amount: String(PRICE_USDT),
      description: 'Dopros Trainer KZ — Lifetime Access',
      payload: JSON.stringify({ userId }),
      expires_in: 3600
    })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error?.message || 'Crypto Pay error');
  return data.result;
}

// ═══════════ СТАТУСЫ ═══════════
const STATUS = {
  witness: 'Свидетель',
  suspect: 'Подозреваемый',
  accused: 'Обвиняемый',
  victim: 'Потерпевший',
  plaintiff: 'Истец',
  defendant: 'Ответчик'
};// ═══════════ СЦЕНАРИИ ═══════════
const SCENARIOS = {
  theft: {
    emoji: '🏪', title: 'Кража в магазине',
    text: 'Меня вызвали на допрос как свидетеля по делу о краже в магазине. Пропал телефон. Следователь утверждает, что камеры показали моего брата рядом с витриной. Он спрашивает, что мне известно о брате и о краже.'
  },
  accident: {
    emoji: '🚗', title: 'ДТП',
    text: 'Я стал свидетелем ДТП на перекрестке. Один водитель скрылся с места происшествия. Следователь вызвал меня на допрос и спрашивает, могу ли я описать водителя и обстоятельства.'
  },
  fraud: {
    emoji: '💰', title: 'Мошенничество',
    text: 'Меня вызвали на допрос как свидетеля по делу о мошенничестве. Мою знакомую подозревают в обмане пожилых людей. Следователь спрашивает, знал ли я о её деятельности и получал ли от неё деньги.'
  },
  burglary: {
    emoji: '🏠', title: 'Кража со взломом',
    text: 'В нашем подъезде произошла кража со взломом квартиры соседа. Меня как свидетеля вызвали на допрос. Следователь спрашивает, видел ли я кого-то подозрительного в день кражи.'
  },
  witness_other: {
    emoji: '🧑‍⚖️', title: 'Свидетель по чужому делу',
    text: 'Меня вызвали на допрос как свидетеля по делу о грабеже. Подозреваемый — мой коллега по работе. Следователь спрашивает, что я знаю о его поведении и где он был в день преступления.'
  },
  drugs: {
    emoji: '💊', title: 'Наркотики',
    text: 'Меня задержали по подозрению в хранении наркотиков. При обыске в моей квартире нашли пакет с веществом, о котором я ничего не знаю. Следователь утверждает, что пакет лежал в моей куртке в шкафу, но я говорю, что не знаю, откуда он там. Также он спрашивает, знаю ли я, кто мог это подкинуть.'
  },
  crypto: {
    emoji: '🪙', title: 'Криптовалюта',
    text: 'Меня вызвали на допрос по делу о незаконном обороте криптовалюты. Знакомый попросил меня обналичить деньги через мой аккаунт на бирже. Я не знал, что эти средства получены преступным путём. Следователь спрашивает о деталях транзакций и моих отношениях с этим знакомым.'
  },
  beating: {
    emoji: '🥊', title: 'Побои',
    text: 'Меня вызывают на допрос по заявлению соседа о нанесении побоев. Я утверждаю, что это была самооборона: он первый напал на меня. Следователь спрашивает о деталях драки, телесных повреждениях и свидетелях.'
  },
  rape: {
    emoji: '⚠️', title: 'Изнасилование',
    text: 'Я — свидетель по делу об изнасиловании. Потерпевшая — моя знакомая. Я видел её с подозреваемым в тот вечер, но не знаю деталей. Следователь спрашивает, что я видел, слышал и знаю об отношениях потерпевшей и подозреваемого.'
  },
  domestic_violence: {
    emoji: '🏠', title: 'Домашнее насилие',
    text: 'Меня вызвали на допрос по факту домашнего насилия в семье. Мой сосед избивает жену, она подала заявление. Я слышал крики из их квартиры несколько раз. Следователь спрашивает, что я знаю о ситуации и могу ли подтвердить факты.'
  },
  fight: {
    emoji: '👊', title: 'Драка',
    text: 'Я был участником массовой драки у ночного клуба. Меня задержали, но я утверждаю, что только защищался. Следователь спрашивает, кто начал драку, кто участвовал и какие травмы были получены.'
  },
  custom: {
    emoji: '📝', title: 'Свой инцидент', text: null
  }
};

// ═══════════ ЯЗЫК / ЮРИСДИКЦИЯ ═══════════
function detectLanguage(text) {
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  const cyr = (text.match(/[а-яА-ЯёЁ]/g) || []).length;
  if (latin + cyr === 0) return 'unknown';
  return latin > cyr ? 'latin' : 'cyrillic';
}

function hasWrongJurisdiction(text) {
  const t = text.toLowerCase();
  if (/конституц[а-я]+ рф|упк рф|ук рф|гпк рф|коап рф|фз\s*№?\s*\d+/.test(t)) return true;
  if (/stpo|stgb|grundgesetz|zpo|owig|strafgesetzbuch/.test(t)) return true;
  if (/us code|federal rules|miranda rights/.test(t)) return true;
  if (/уголовн[а-я]+ кодекс украины|ук беларуси|ук узбекистана|ук кыргызстана/.test(t)) return true;
  return false;
}

// ═══════════ ХЕЛПЕРЫ ИСТОРИИ ═══════════
function countUserTurns(history) {
  if (!Array.isArray(history)) return 0;
  return history.filter(m =>
    m.role === 'user' && !m.content.startsWith('Инцидент:')
  ).length;
}

function historyToText(history) {
  if (!Array.isArray(history)) return String(history || '');
  return history.map(m => {
    const prefix = m.role === 'assistant' ? '🎭 Следователь:' : '👤 Вы:';
    return `${prefix} ${m.content}`;
  }).join('\n\n');
}

function buildLawsContext(articles) {
  if (!articles.length) return '(нет найденных статей)';
  return articles.map(a => {
    const head = a.code && a.article
      ? `${a.code}, ${a.article}: ${a.title}`
      : a.title;
    return `\n### ${head}\n${a.text}\n`;
  }).join('\n');
  }// ═══════════ ПРОМПТ: ВОПРОС СЛЕДОВАТЕЛЯ ═══════════
function buildQuestionPrompt(status, incident, history, laws, round = 1) {
  const statusText = STATUS[status];
  const lawsContext = buildLawsContext(laws);
  const historyText = historyToText(history);
  const userTurns = countUserTurns(history);

  let phase = 'разогрев';
  if (userTurns >= 3 && userTurns <= 5) phase = 'давление';
  if (userTurns >= 6) phase = 'загон';

  const delicate = /изнасилован|насили/i.test(incident);

  return `Ты — следователь (дознаватель) в Республике Казахстан.
Ты СОБИРАТЕЛЬНЫЙ ОБРАЗ лучших следователей мировой литературы и кино.

═══════ ТВОЙ ХАРАКТЕР ═══════
Ты сочетаешь: Порфирия Петровича (мягкость, ловля на оговорках), Коломбо (прикидываешься простаком), Жеглова (сухость и жёсткость), Эркюля Пуаро (логика), Мисс Марпл (простодушие), Шерлока Холмса (наблюдательность), Босха (хладнокровие), Кроуфорда (чтение людей), Старлинг (детали), Кэтрин Дэнс (факты), Марлоу (ирония), Спейда (расчёт), Райма (детали), Шимански (немецкая логика), Гюнтера (жёсткость), Рата (психология), Мартина Бека (методичность).

Это ОДИН следователь, который МЕНЯЕТ МАСКУ в зависимости от фазы.

═══════ ПРИНЦИПЫ ═══════
1. Никогда не угрожаешь прямо. Давишь намёками, логикой.
2. Никогда не выдумываешь доказательства как факт. Только «есть данные», «свидетель показал».
3. Хвалишь за честность — но не веришь ей.
4. Любишь внезапно сменить тему.
5. Замечаешь противоречия. Мягко подсвечиваешь.
6. Всегда спокоен. Никогда не повышаешь голос.
7. Работаешь с фактами и деталями.

═══════ ФАЗА: ${phase.toUpperCase()} ═══════
${phase === 'разогрев' ? `
ФАЗА «РАЗОГРЕВ». Цель: разговорить, собрать факты.
Маска: Мисс Марпл + Порфирий + Мартин Бек.
— Вежливый, участливый, немного рассеянный.
— Открытые вопросы: «расскажите», «уточните».
— Бытовая фраза: «Чайник поставил, налью себе. Вы не против?»
` : phase === 'давление' ? `
ФАЗА «ДАВЛЕНИЕ». Цель: поймать на противоречиях.
Маска: Коломбо + Пуаро + Босх.
— Прикидываешься, что «запутался».
— Подсвечиваешь противоречия в показаниях.
— Гипотезы: «А если я вам скажу, что есть запись?»
— Мягкая угроза: «Прокурор может истолковать иначе».
` : `
ФАЗА «ЗАГОН». Цель: вынудить к реакции.
Маска: Жеглов + Пуаро + Гюнтер.
— Сухо, холодно, без лишних слов.
— Прямые вопросы: «Вы понимаете, что молчание — тоже показание?»
— Намёк на последствия: «Мы можем оформить это как...»
— Холодное резюме: «Значит, не помните. Так и запишем.»
`}
${delicate ? `
═══════ ОСОБЫЙ РЕЖИМ ДЕЛИКАТНОСТИ ═══════
— НЕ описывай сцены насилия.
— НЕ детализируй физические действия.
— Формулировки строго процессуальные, сухие.
— Проявляй уважение к потерпевшим.
` : ''}
═══════ ЖЁСТКИЕ ПРАВИЛА ═══════
1. ТОЛЬКО ОДИН вопрос.
2. ЯЗЫК — только РУССКИЙ.
3. СТРАНА — Казахстан. Статус: ${statusText}.
4. Длина: 1–3 предложения.
5. Никогда не подсказывай правильный ответ.
6. Никогда не выходи из роли.
7. Никогда не цитируй законы других стран.
8. Один вопрос — одна тема.

═══════ КОНТЕКСТ ═══════
ИНЦИДЕНТ: ${incident}
РАУНД: ${round}

ДИАЛОГ:
${historyText || '(начало допроса)'}

СТАТЬИ КАЗАХСТАНА (для справки):
${lawsContext}

═══════ ФОРМАТ ═══════
🎭 Следователь: [вопрос]

ТОЛЬКО эта строка.`;
}

// ═══════════ ПРОМПТ: ОЦЕНКА ═══════════
function buildEvaluationPrompt(status, incident, history, laws) {
  return `⚠️ ТОЛЬКО РУССКИЙ. ⚠️ ТОЛЬКО законы КАЗАХСТАНА.
Страна: Казахстан. Статус: ${STATUS[status]}.
ИНЦИДЕНТ: ${incident}
ДИАЛОГ:
${historyToText(history)}
СТАТЬИ: ${buildLawsContext(laws)}
ФОРМАТ (строго):
📊 Оценка: [✅ / ⚠️ / ❌]
⚠️ Ошибка: [1 предложение или "нет"]
🎯 Эталон: «[правильная формулировка]»
📚 Статьи: [названия]
💬 Коротко: [1-2 предложения]`;
}

// ═══════════ ПРОМПТ: ПОДСКАЗКА ═══════════
function buildHintPrompt(status, incident, history, laws) {
  return `⚠️ ТОЛЬКО РУССКИЙ. Максимум 2 предложения.
Страна: Казахстан. Статус: ${STATUS[status]}.
ИНЦИДЕНТ: ${incident}
ДИАЛОГ:
${historyToText(history)}
СТАТЬИ: ${buildLawsContext(laws)}
ФОРМАТ: 💡 Подсказка: [максимум 2 предложения]`;
}

// ═══════════ ПРОМПТ: СМЫСЛ ВОПРОСА ═══════════
function buildMeaningPrompt(question, incident, laws) {
  return `⚠️ ТОЛЬКО РУССКИЙ.
Ты — тренер-адвокат. Объясни пользователю, что следователь имел в виду. Какую ловушку он поставил.
ВОПРОС: "${question}"
ИНЦИДЕНТ: ${incident}
СТАТЬИ: ${buildLawsContext(laws)}
ФОРМАТ:
🤔 Что имел в виду следователь:
• 🎯 Цель вопроса: [1 предложение]
• ⚠️ Ловушка: [1 предложение]
• 🛡️ Как отвечать: [2-3 варианта формулировок]
• 📚 Основание: [статья из КАЗАХСТАНА]
ТОЛЬКО ЭТОТ ФОРМАТ.`;
}

// ═══════════ ПРОМПТ: ДЕЙСТВИЕ ═══════════
function buildActionPrompt(action, status, incident, question) {
  const actions = {
    silence: 'право на молчание (ст. 77 п. 7 Конституции РК)',
    lawyer: 'право на защитника (ст. 64, 65-1 УПК РК)',
    break: 'право на перерыв (ст. 210 УПК РК)',
    note: 'право на замечания в протокол (ст. 64 УПК РК)',
    pressure: 'право жаловаться на давление',
    translator: 'право на переводчика (ст. 64 УПК РК)',
    refuse_sign: 'право отказаться от подписи',
    clarify: 'право уточнить вопрос'
  };
  return `⚠️ ТОЛЬКО РУССКИЙ.
Ситуация: ${actions[action] || action}.
Статус: ${STATUS[status]}.
Вопрос: "${question || '(нет)'}"
ИНЦИДЕНТ: ${incident}
ФОРМАТ:
🛡️ *${actions[action] || action}*
📝 Формулировка: «[фраза]»
⚖️ Основание: [статья]
💡 Совет: [1 предложение]`;
}

// ═══════════ ПРОМПТ: ЖАЛОБА ═══════════
function buildComplaintPrompt(type, status, incident) {
  const types = {
    prosecutor: 'жалоба прокурору',
    higher: 'жалоба в вышестоящий орган',
    protocol: 'внести в протокол',
    document: 'зафиксировать нарушение'
  };
  return `⚠️ ТОЛЬКО РУССКИЙ. Инструкция: ${types[type] || type}.
Статус: ${STATUS[status]}. ИНЦИДЕНТ: ${incident}
ФОРМАТ:
📞 *${types[type] || type}*
📝 Куда/что: [1-2 предложения]
🎯 Как: 1. [шаг] 2. [шаг] 3. [шаг]
⚖️ Основание: [статья]`;
}

// ═══════════ ПРОМПТ: ИТОГ ═══════════
function buildSummaryPrompt(status, incident, history, laws, stats) {
  return `⚠️ ТОЛЬКО РУССКИЙ. ⚠️ ТОЛЬКО законы КАЗАХСТАНА.
Статус: ${STATUS[status]}. Статистика: ✅ ${stats.correct}, ⚠️ ${stats.warnings}, ❌ ${stats.errors}.
ИНЦИДЕНТ: ${incident}
ДИАЛОГ:
${historyToText(history)}
СТАТЬИ: ${buildLawsContext(laws)}
ФОРМАТ:
🎓 ИТОГ ТРЕНИРОВКИ
✅ Правильных: ${stats.correct}
⚠️ С замечаниями: ${stats.warnings}
❌ Ошибок: ${stats.errors}
📊 Слабые места: • [1] • [2]
💡 Что повторить: • [1] • [2]
🎯 Рекомендация: [1-2 предложения]`;
}

// ═══════════ ПРОМПТ: ОТВЕТ АДМИНА ═══════════
function buildAdminReplyPrompt(userMessage, username) {
  const FAQ = `
О БОТЕ:
• Что это? — Тренажёр допроса для Казахстана.
• Это консультация юриста? — НЕТ.
• Язык — только русский.
ОПЛАТА:
• Сколько стоит? — ${PRICE_STARS} Stars ИЛИ ${PRICE_USDT} USDT.
• Что даёт? — Вечный доступ, без подписок.
• Бесплатно? — 1 тренировка.
• Возврат? — НЕТ.
ФУНКЦИИ:
• 12 сценариев: кража, ДТП, мошенничество, взлом, свидетель, наркотики, крипта, побои, изнасилование, домашнее насилие, драка + свой.
• Кнопка «🛡️ Мои права» — 8 действий.
ПРИВАТНОСТЬ:
• /privacy — политика.
• /delete_me — удаление.
ПОДДЕРЖКА:
• Время ответа — до 24 часов.
`;
  return `Ты — администратор бота "Dopros Trainer KZ".
Пользователь: ${username || 'без username'}
СООБЩЕНИЕ: "${userMessage}"
${FAQ}
ПРАВИЛА:
1. Простые вопросы — отвечай сам, макс 4 предложения.
2. Сложные (возврат, баг, жалоба, юр. вопрос) — ответь ТОЛЬКО: «Передал ваш вопрос администратору. Он ответит лично в течение 24 часов.»
3. Не обещай возврат. Не давай юр. консультаций.
4. На «вы», вежливо, на русском.
ФОРМАТ:
CATEGORY: [SIMPLE или COMPLEX]
REPLY: [текст]`;
}
