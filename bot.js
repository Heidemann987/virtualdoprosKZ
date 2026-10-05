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
}// ═══════════ КЛАВИАТУРЫ ═══════════
function mainReplyKeyboard() {
  return new Keyboard()
    .text('🎓 Завершить').text('💡 Подсказка').row()
    .text('🛡️ Мои права').text('📊 Итог').row()
    .text('💬 Написать админу').text('🔄 Сменить статус')
    .resized().persistent();
}

function questionInlineKeyboard() {
  return new InlineKeyboard()
    .text('💡 Подсказка', 'hint').row()
    .text('🤔 Что он имел в виду?', 'meaning').row()
    .text('🛡️ Мои права', 'rights_menu').row()
    .text('⏭️ Пропустить', 'skip_question');
}

function rightsInlineKeyboard() {
  return new InlineKeyboard()
    .text('🛡️ Право на молчание', 'act:silence').row()
    .text('👨‍⚖️ Позвать адвоката', 'act:lawyer').row()
    .text('⏸️ Попросить перерыв', 'act:break').row()
    .text('📝 Записать замечание', 'act:note').row()
    .text('⚠️ Жалоба на давление', 'act:pressure').row()
    .text('🌐 Требовать переводчика', 'act:translator').row()
    .text('🚫 Отказаться подписывать', 'act:refuse_sign').row()
    .text('🔍 Уточнить вопрос', 'act:clarify').row()
    .text('📞 Жалобы и фиксация', 'complaint_menu');
}

function complaintsInlineKeyboard() {
  return new InlineKeyboard()
    .text('📞 Прокурору', 'comp:prosecutor').row()
    .text('📧 В вышестоящий орган', 'comp:higher').row()
    .text('📝 Записать в протокол', 'comp:protocol').row()
    .text('📸 Зафиксировать нарушение', 'comp:document').row()
    .text('← Назад', 'rights_menu');
}

function afterEvalInlineKeyboard() {
  return new InlineKeyboard()
    .text('📊 Сравнить с эталоном', 'compare_with_standard').row()
    .text('📚 Показать статьи', 'show_laws');
}

function paywallKeyboard() {
  return new InlineKeyboard()
    .text(`⭐ Оплатить Stars — ${PRICE_STARS}`, 'pay:stars').row()
    .text('💼 Как открыть кошелёк', 'wallet:howto').row()
    .text(`💎 Оплатить через Wallet — ${PRICE_USDT} USDT`, 'pay:usdt').row()
    .text('🔒 Политика конфиденциальности', 'show_privacy').row()
    .text('💬 Написать админу', 'contact_admin');
}

function progressBar(sess) {
  return `📊 *Раунд ${sess.round}*  ·  ✅ ${sess.correct}  ⚠️ ${sess.warnings}  ❌ ${sess.errors}`;
}

// ═══════════ БОТ ═══════════
const bot = new Bot(BOT_TOKEN);
const sessions = new Map();

bot.catch(async (err) => {
  console.error('Bot error:', err);
  await logError(err, err.ctx?.from?.id);
});

// ═══════════ AI ═══════════
async function callAI(prompt, maxTokens, attempt = 1) {
  let text = '';
  try {
    const r = await ai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: maxTokens
    });
    text = r.choices[0].message.content || '';
  } catch (e) {
    const is429 = e.message && (
      e.message.includes('429') ||
      e.message.includes('rate') ||
      e.message.includes('quota')
    );
    if (is429 && attempt < 3) {
      const wait = attempt * 15;
      console.log(`⏳ Rate limit, ждём ${wait}с...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      return callAI(prompt, maxTokens, attempt + 1);
    }
    throw e;
  }

  const wrong = detectLanguage(text) === 'latin' || hasWrongJurisdiction(text);
  if (wrong) {
    try {
      const retry = await ai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: text },
          { role: 'user', content: 'НЕВЕРНО! Только РУССКИЙ. Только законы КАЗАХСТАНА. Только формат.' }
        ],
        temperature: 0.2,
        max_tokens: maxTokens
      });
      const rt = retry.choices[0].message.content || '';
      if (!hasWrongJurisdiction(rt) && detectLanguage(rt) !== 'latin') text = rt;
    } catch (e) {}
  }
  return text;
}

// ═══════════ СЕССИИ ═══════════
function getSession(userId) {
  return sessions.get(userId) || null;
}

function createSession(userId, mode) {
  const sess = {
    mode: mode || 'beginner',
    status: null,
    incident: null,
    history: [],
    round: 0,
    correct: 0,
    warnings: 0,
    errors: 0,
    actionsUsed: 0,
    currentQuestion: null,
    lastLaws: [],
    lastEvaluation: null,
    lastUserAnswer: null,
    chatWithAdmin: false,
    replyToUserId: null,
    replyMsgId: null,
    awaitingCustomIncident: false
  };
  sessions.set(userId, sess);
  return sess;
}

// ═══════════ СТАРТ ТРЕНИРОВКИ ═══════════
async function startTraining(ctx, sess, incidentText) {
  sess.incident = incidentText;
  sess.history = [];
  sess.round = 1;
  sess.correct = 0;
  sess.warnings = 0;
  sess.errors = 0;

  try {
    await usersCol.updateOne(
      { userId: ctx.from.id },
      { $inc: { sessions: 1 } }
    );
  } catch (e) {}

  const relevant = await findRelevantArticles(incidentText, 5);
  sess.lastLaws = relevant;

  try {
    await ctx.replyWithChatAction('typing');
    const question = await callAI(
      buildQuestionPrompt(
        sess.status, sess.incident, sess.history, relevant, sess.round
      ),
      500
    );
    sess.currentQuestion = question;
    sess.history.push({ role: 'assistant', content: question });

    await ctx.reply(
      '⚖️ *Тренажёр запущен.*\n\nКнопки внизу — быстрые действия.',
      { parse_mode: 'Markdown', reply_markup: mainReplyKeyboard() }
    );
    await ctx.reply(progressBar(sess), { parse_mode: 'Markdown' });
    await ctx.reply(question, {
      parse_mode: 'Markdown',
      reply_markup: questionInlineKeyboard()
    });
  } catch (e) {
    console.error(e);
    await logError(e, ctx.from.id);
    await ctx.reply('⚠️ Ошибка ИИ. Попробуйте /start заново.');
  }
}

// ═══════════ СЛЕДУЮЩИЙ ВОПРОС ═══════════
async function askNextQuestion(ctx, sess) {
  try {
    await ctx.replyWithChatAction('typing');
    const question = await callAI(
      buildQuestionPrompt(
        sess.status, sess.incident, sess.history, sess.lastLaws, sess.round
      ),
      500
    );
    sess.currentQuestion = question;
    sess.history.push({ role: 'assistant', content: question });

    await ctx.reply(progressBar(sess), { parse_mode: 'Markdown' });
    await ctx.reply(question, {
      parse_mode: 'Markdown',
      reply_markup: questionInlineKeyboard()
    });
  } catch (e) {
    console.error(e);
    await logError(e, ctx.from.id);
    await ctx.reply('⚠️ Ошибка ИИ. Попробуйте /start.');
  }
}

// ═══════════ ОБРАБОТКА ОТВЕТА ═══════════
async function handleUserAnswer(ctx, sess, answerText) {
  sess.lastUserAnswer = answerText;
  sess.history.push({ role: 'user', content: answerText });

  try {
    await ctx.replyWithChatAction('typing');

    const evaluation = await callAI(
      buildEvaluationPrompt(
        sess.status, sess.incident, sess.history, sess.lastLaws
      ),
      400
    );
    sess.lastEvaluation = evaluation;

    if (evaluation.includes('✅')) sess.correct++;
    else if (evaluation.includes('❌')) sess.errors++;
    else sess.warnings++;

    await ctx.reply(evaluation, {
      parse_mode: 'Markdown',
      reply_markup: afterEvalInlineKeyboard()
    });

    const u = await usersCol.findOne({ userId: ctx.from.id });
    if (u && !u.paid && !u.trialUsed) {
      await markTrialUsed(ctx.from.id);
    }

    sess.round++;
    await askNextQuestion(ctx, sess);
  } catch (e) {
    console.error(e);
    await logError(e, ctx.from.id);
    await ctx.reply('⚠️ Ошибка обработки. Попробуйте ещё раз.');
  }
}

// ═══════════ ПОДСКАЗКА ═══════════
async function handleHint(ctx) {
  const sess = getSession(ctx.from.id);
  if (!sess || !sess.incident) return ctx.reply('Начните с /start');
  try {
    await ctx.replyWithChatAction('typing');
    const hint = await callAI(
      buildHintPrompt(
        sess.status, sess.incident, sess.history, sess.lastLaws
      ),
      200
    );
    await ctx.reply(hint, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(e);
    await logError(e, ctx.from.id);
    await ctx.reply('⚠️ Ошибка подсказки.');
  }
}

// ═══════════ СМЫСЛ ВОПРОСА ═══════════
async function handleMeaning(ctx) {
  const sess = getSession(ctx.from.id);
  if (!sess || !sess.currentQuestion) return ctx.reply('Начните с /start');
  try {
    await ctx.replyWithChatAction('typing');
    const meaning = await callAI(
      buildMeaningPrompt(
        sess.currentQuestion, sess.incident, sess.lastLaws
      ),
      500
    );
    await ctx.reply(meaning, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(e);
    await logError(e, ctx.from.id);
    await ctx.reply('⚠️ Ошибка анализа.');
  }
}

// ═══════════ ИТОГ ═══════════
async function handleFinish(ctx) {
  const sess = getSession(ctx.from.id);
  if (!sess || !sess.incident) return ctx.reply('Нет активной тренировки. /start');

  try {
    await ctx.replyWithChatAction('typing');
    const stats = {
      correct: sess.correct,
      warnings: sess.warnings,
      errors: sess.errors
    };
    const summary = await callAI(
      buildSummaryPrompt(
        sess.status, sess.incident, sess.history, sess.lastLaws, stats
      ),
      700
    );

    await ctx.reply(summary, { parse_mode: 'Markdown' });
    await ctx.reply(
      '━━━━━━━━━━━━━━━━━━━━\n\n🔄 /start — новая тренировка',
      { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
    );

    sess.incident = null;
    sess.history = [];
    sess.currentQuestion = null;
    sess.round = 0;
  } catch (e) {
    console.error(e);
    await logError(e, ctx.from.id);
    await ctx.reply('⚠️ Ошибка итога.');
  }// ═══════════ /start ═══════════
bot.command('start', async (ctx) => {
  const userId = ctx.from.id;
  const u = await getUser(userId, ctx.from);
  sessions.delete(userId);

  if (u.banned) return ctx.reply('🚫 Вы заблокированы.');

  const WELCOME =
    '⚖️ *Dopros Trainer KZ*\n' +
    '_AI-тренажёр допроса для Казахстана_\n\n' +
    '━━━━━━━━━━━━━━━━━━━━\n\n' +
    'Вы пройдёте реалистичную симуляцию общения со следователем — с разбором каждой ловушки и ссылками на УПК РК.\n\n' +
    '*Как это работает:*\n' +
    '1️⃣ Опишете ситуацию или выберете сценарий\n' +
    '2️⃣ Ответите на вопросы следователя\n' +
    '3️⃣ После каждого ответа — разбор + эталон\n' +
    '4️⃣ В конце — оценка и рекомендации\n\n' +
    '*Что внутри:*\n' +
    '• 12 сценариев (кража, ДТП, мошенничество, взлом, свидетель, наркотики, крипта, побои, изнасилование, домашнее насилие, драка)\n' +
    '• 6 процессуальных статусов\n' +
    '• 8 процессуальных действий\n' +
    '• Итоговая оценка\n\n' +
    '━━━━━━━━━━━━━━━━━━━━\n\n' +
    '🎁 *Первая тренировка — бесплатно*\n' +
    '🔒 Персональные данные не собираются\n\n' +
    '⚠️ Это тренажёр, не замена адвоката\n\n' +
    '*Выберите режим:*';

  if (!u.paid && !u.trialUsed) {
    return ctx.reply(WELCOME, {
      parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard()
        .text('🎓 Новичок', 'mode:beginner').row()
        .text('📝 Экзамен', 'mode:exam')
    });
  }

  if (!u.paid && u.trialUsed) {
    return ctx.reply(
      '🔒 *Бесплатная тренировка завершена*\n\n' +
      '━━━━━━━━━━━━━━━━━━━━\n\n' +
      'Понравилось? Откройте *полный доступ*:\n\n' +
      '✅ Неограниченные тренировки\n' +
      '✅ Все сценарии и статусы\n' +
      '✅ Разбор каждой ловушки\n' +
      '✅ Итоговая оценка с рекомендациями\n' +
      '✅ Доступ навсегда, без подписок\n\n' +
      '━━━━━━━━━━━━━━━━━━━━\n\n' +
      `💎 Всего *${PRICE_USDT} USDT* ИЛИ *${PRICE_STARS} Stars*`,
      { parse_mode: 'Markdown', reply_markup: paywallKeyboard() }
    );
  }

  await ctx.reply(
    '⚖️ *Dopros Trainer KZ*\n\n' +
    '✅ *Доступ активен навсегда*\n\n' +
    '━━━━━━━━━━━━━━━━━━━━\n\n' +
    '*Выберите режим:*',
    {
      parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard()
        .text('🎓 Новичок', 'mode:beginner').row()
        .text('📝 Экзамен', 'mode:exam')
    }
  );
});

// ═══════════ /help ═══════════
bot.command('help', async (ctx) => {
  await ctx.reply(
    '⚖️ *Dopros Trainer KZ*\n\n' +
    '• /start — начать\n' +
    '• /reset — сбросить сессию\n' +
    '• /finish — итог тренировки\n' +
    '• /privacy — политика конфиденциальности\n' +
    '• /delete_me — удалить мои данные\n' +
    '• /help — справка\n\n' +
    '📚 Статьи: УК РК, УПК РК, Конституция РК.',
    { parse_mode: 'Markdown' }
  );
});

// ═══════════ /reset ═══════════
bot.command('reset', async (ctx) => {
  sessions.delete(ctx.from.id);
  await ctx.reply('🔄 Сессия сброшена. Отправьте /start.', {
    reply_markup: { remove_keyboard: true }
  });
});

// ═══════════ /finish ═══════════
bot.command('finish', async (ctx) => {
  await handleFinish(ctx);
});

// ═══════════ /privacy ═══════════
bot.command('privacy', async (ctx) => {
  await ctx.reply(
    `🔒 *Политика конфиденциальности*\n\n` +
    `Бот *не собирает* персональные данные:\n` +
    `• ФИО, ИИН, адрес, телефон\n` +
    `• Email, карта, паспорт\n\n` +
    `*Что хранится:*\n` +
    `• Telegram ID\n` +
    `• Username (публичный)\n` +
    `• Статус оплаты и сумма\n` +
    `• Дата последнего обращения\n\n` +
    `*Кому передаются:*\n` +
    `• Telegram — работа бота\n` +
    `• Crypto Pay — приём USDT\n` +
    `• AI — только текст сообщений\n\n` +
    `*Хранение:* до удаления.\n` +
    `*Удаление:* /delete_me\n\n` +
    `Используя бота, вы соглашаетесь с политикой.`,
    { parse_mode: 'Markdown' }
  );
});

// ═══════════ /delete_me ═══════════
bot.command('delete_me', async (ctx) => {
  const kb = new InlineKeyboard()
    .text('❌ Да, удалить', 'confirm_delete').row()
    .text('← Отмена', 'cancel_delete');
  await ctx.reply(
    `⚠️ *Удаление данных*\n\n` +
    `Будут удалены:\n` +
    `• Telegram ID\n` +
    `• Статус оплаты\n` +
    `• История обращений\n\n` +
    `⚠️ Платный доступ будет утерян без возврата.\n\n` +
    `Продолжить?`,
    { parse_mode: 'Markdown', reply_markup: kb }
  );
});

bot.callbackQuery('confirm_delete', async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;
  try {
    await usersCol.deleteOne({ userId });
    sessions.delete(userId);
    if (ADMIN_ID) {
      try {
        await ctx.api.sendMessage(
          ADMIN_ID,
          `🗑 Пользователь удалил данные\n🆔 \`${userId}\``,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {}
    }
    await ctx.reply(
      '✅ *Данные удалены*\n\nTelegram ID удалён из базы.',
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error(e);
    await ctx.reply('⚠️ Ошибка удаления. Напишите админу.');
  }
});

bot.callbackQuery('cancel_delete', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply('❌ Удаление отменено.');
});

// ═══════════ /cancel ═══════════
bot.command('cancel', async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (s) {
    s.chatWithAdmin = false;
    s.replyToUserId = null;
    s.replyMsgId = null;
    s.awaitingCustomIncident = false;
  }
  await ctx.reply('❌ Отменено.');
});

// ═══════════ /admin ═══════════
bot.command('admin', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ Нет доступа.');
  await sendAdminPanel(ctx);
});

bot.callbackQuery('admin:refresh', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_ID) return;
  try { await ctx.deleteMessage(); } catch (e) {}
  await sendAdminPanel(ctx);
});

async function sendAdminPanel(ctx) {
  const total = await usersCol.countDocuments();
  const paid = await usersCol.countDocuments({ paid: true });
  const trial = await usersCol.countDocuments({ trialUsed: true, paid: false });
  const notStarted = await usersCol.countDocuments({ trialUsed: false, paid: false });
  const errors = await errorsCol.countDocuments();
  const unreadMsgs = await messagesCol.countDocuments({ replied: false });

  const now = new Date();
  const day = new Date(now.getTime() - 24 * 3600 * 1000);
  const week = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const month = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

  const newToday = await usersCol.countDocuments({ createdAt: { $gte: day } });
  const newWeek = await usersCol.countDocuments({ createdAt: { $gte: week } });
  const newMonth = await usersCol.countDocuments({ createdAt: { $gte: month } });

  const activeToday = await usersCol.countDocuments({ lastSeen: { $gte: day } });
  const activeWeek = await usersCol.countDocuments({ lastSeen: { $gte: week } });

  const revStars = await paymentsCol.aggregate([
    { $match: { status: 'paid', method: 'stars' } },
    { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } }
  ]).toArray();

  const revUsdt = await paymentsCol.aggregate([
    { $match: { status: 'paid', method: 'usdt' } },
    { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } }
  ]).toArray();

  const revStarsToday = await paymentsCol.aggregate([
    { $match: { status: 'paid', method: 'stars', paidAt: { $gte: day } } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]).toArray();

  const revUsdtToday = await paymentsCol.aggregate([
    { $match: { status: 'paid', method: 'usdt', paidAt: { $gte: day } } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]).toArray();

  const topScenarios = await usersCol.aggregate([
    { $match: { sessions: { $gt: 0 } } },
    { $group: { _id: null, total: { $sum: '$sessions' } } }
  ]).toArray();

  const conversion = trial + paid > 0
    ? ((paid / (trial + paid)) * 100).toFixed(1)
    : '0';

  const sStars = revStars[0]?.total || 0;
  const sStarsCount = revStars[0]?.count || 0;
  const sUsdt = revUsdt[0]?.total || 0;
  const sUsdtCount = revUsdt[0]?.count || 0;
  const starsToday = revStarsToday[0]?.total || 0;
  const usdtToday = revUsdtToday[0]?.total || 0;
  const sessionsTotal = topScenarios[0]?.total || 0;

  const text =
    `🔐 *АДМИН-ПАНЕЛЬ*\n` +
    `_${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}_\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👥 *ПОЛЬЗОВАТЕЛИ*\n` +
    `• Всего: *${total}*\n` +
    `• ✅ Платных: *${paid}*\n` +
    `• 🎁 Пробных: *${trial}*\n` +
    `• ⚪ Не начали: *${notStarted}*\n` +
    `• 📈 Конверсия: *${conversion}%*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📅 *ДИНАМИКА*\n` +
    `• Новых сегодня: *${newToday}*\n` +
    `• Новых за 7 дней: *${newWeek}*\n` +
    `• Новых за 30 дней: *${newMonth}*\n\n` +
    `• Активных сегодня: *${activeToday}*\n` +
    `• Активных за 7 дней: *${activeWeek}*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 *ДОХОДЫ*\n` +
    `⭐ Stars: *${sStars}* XTR (${sStarsCount} шт)\n` +
    `💎 USDT: *${sUsdt}* USDT (${sUsdtCount} шт)\n\n` +
    `📅 За сегодня:\n` +
    `• ⭐ ${starsToday} XTR\n` +
    `• 💎 ${usdtToday} USDT\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎯 *ТРЕНИРОВКИ*\n` +
    `• Всего сессий: *${sessionsTotal}*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `❌ Ошибок: *${errors}*\n` +
    `💬 Непрочитанных: *${unreadMsgs}*\n`;

  const kb = new InlineKeyboard()
    .text('👥 Пользователи', 'admin:users').row()
    .text('💰 Платежи', 'admin:payments').row()
    .text('📊 Топ сценариев', 'admin:top').row()
    .text('❌ Ошибки', 'admin:errors').row()
    .text('💬 Сообщения', 'admin:messages').row()
    .text('📢 Рассылка', 'admin:broadcast').row()
    .text('🎁 Выдать доступ', 'admin:grant').row()
    .text('🚫 Забанить', 'admin:ban').row()
    .text('📤 Экспорт CSV', 'admin:export').row()
    .text('🔄 Обновить', 'admin:refresh');

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
}

// ═══════════ АДМИН: ПОЛЬЗОВАТЕЛИ ═══════════
bot.callbackQuery('admin:users', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_ID) return;

  const kb = new InlineKeyboard()
    .text('🆕 Новые', 'admin:users:new').row()
    .text('✅ Платные', 'admin:users:paid').row()
    .text('🎁 Пробные', 'admin:users:trial').row()
    .text('🔥 Активные 24ч', 'admin:users:active').row()
    .text('← Назад', 'admin:refresh');

  await ctx.reply('👥 *Фильтр пользователей:*', {
    parse_mode: 'Markdown', reply_markup: kb
  });
});

bot.callbackQuery(/^admin:users:(new|paid|trial|active)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_ID) return;

  const filter = ctx.match[1];
  let query = {};
  const day = new Date(Date.now() - 24 * 3600 * 1000);

  if (filter === 'new') query = { createdAt: { $gte: day } };
  else if (filter === 'paid') query = { paid: true };
  else if (filter === 'trial') query = { trialUsed: true, paid: false };
  else if (filter === 'active') query = { lastSeen: { $gte: day } };

  const users = await usersCol.find(query).sort({ lastSeen: -1 }).limit(20).toArray();
  if (!users.length) return ctx.reply('Нет пользователей.');

  let text = `👥 *${filter.toUpperCase()}* (${users.length}):\n\n`;
  for (const u of users) {
    const status = u.paid ? '✅' : (u.trialUsed ? '🎁' : '⚪');
    const name = `${u.firstName || '—'}${u.username ? ' @' + u.username : ''}`;
    text += `${status} ${name}\n`;
    text += `   🆔 \`${u.userId}\`\n`;
    text += `   🎯 Сессий: ${u.sessions || 0}\n\n`;
  }
  await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ═══════════ АДМИН: ПЛАТЕЖИ ═══════════
bot.callbackQuery('admin:payments', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_ID) return;

  const payments = await paymentsCol.find({ status: 'paid' })
    .sort({ paidAt: -1 }).limit(15).toArray();

  if (!payments.length) return ctx.reply('Платежей нет.');

  let text = '💰 *Последние 15 платежей:*\n\n';
  for (const p of payments) {
    const icon = p.method === 'stars' ? '⭐' : '💎';
    const date = (p.paidAt || p.createdAt)?.toISOString().slice(0, 16).replace('T', ' ') || '—';
    text += `${icon} \`${p.userId}\` — ${p.amount} ${p.method === 'stars' ? 'XTR' : 'USDT'}\n`;
    text += `   📅 ${date}\n\n`;
  }
  await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ═══════════ АДМИН: ТОП ═══════════
bot.callbackQuery('admin:top', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_ID) return;

  const top = await usersCol.aggregate([
    { $match: { sessions: { $gt: 0 } } },
    { $group: { _id: '$userId', sessions: { $sum: '$sessions' } } },
    { $sort: { sessions: -1 } },
    { $limit: 10 }
  ]).toArray();

  if (!top.length) return ctx.reply('Нет данных.');

  let text = '📊 *Топ-10 по сессиям:*\n\n';
  let i = 1;
  for (const t of top) {
    const u = await usersCol.findOne({ userId: t._id });
    const name = u ? `${u.firstName || '—'}${u.username ? ' @' + u.username : ''}` : '—';
    text += `${i}. ${name}\n   🎯 ${t.sessions} | \`${t._id}\`\n\n`;
    i++;
  }
  await ctx.reply(text, { parse_mode: 'Markdown' });
});// ═══════════ АДМИН: ОШИБКИ ═══════════
bot.callbackQuery('admin:errors', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_ID) return;

  const errs = await errorsCol.find().sort({ createdAt: -1 }).limit(10).toArray();
  if (!errs.length) return ctx.reply('Ошибок нет ✅');

  let text = '❌ *Последние 10 ошибок:*\n\n';
  for (const e of errs) {
    const date = e.createdAt.toISOString().slice(0, 19).replace('T', ' ');
    text += `• \`${String(e.message).slice(0, 100)}\`\n`;
    text += `   🆔 ${e.userId || '—'} | 📅 ${date}\n\n`;
  }
  const kb = new InlineKeyboard().text('🗑 Очистить', 'admin:errors:clear');
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
});

bot.callbackQuery('admin:errors:clear', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Очищено' });
  if (ctx.from.id !== ADMIN_ID) return;
  await errorsCol.deleteMany({});
  await ctx.reply('✅ Ошибки очищены.');
});

// ═══════════ АДМИН: СООБЩЕНИЯ ═══════════
bot.callbackQuery('admin:messages', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_ID) return;

  const msgs = await messagesCol.find({ replied: false })
    .sort({ createdAt: -1 }).limit(10).toArray();

  if (!msgs.length) return ctx.reply('Нет новых сообщений ✅');

  for (const m of msgs) {
    const u = await usersCol.findOne({ userId: m.fromUserId });
    const name = u ? `${u.firstName || '—'}${u.username ? ' @' + u.username : ''}` : '';
    const kb = new InlineKeyboard()
      .text('↩️ Ответить', `reply:${m._id}`)
      .text('✅ Прочитано', `admin:msg:read:${m._id}`);

    await ctx.reply(
      `💬 *От* \`${m.fromUserId}\` ${name}\n📅 ${m.createdAt.toISOString().slice(0, 16).replace('T', ' ')}\n\n${m.text}`,
      { parse_mode: 'Markdown', reply_markup: kb }
    );
  }
});

bot.callbackQuery(/^admin:msg:read:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Отмечено' });
  if (ctx.from.id !== ADMIN_ID) return;
  try {
    await messagesCol.updateOne(
      { _id: new ObjectId(ctx.match[1]) },
      { $set: { replied: true, repliedAt: new Date() } }
    );
    await ctx.deleteMessage();
  } catch (e) { await ctx.reply('⚠️ Ошибка'); }
});

// ═══════════ АДМИН: ОТВЕТ ПОЛЬЗОВАТЕЛЮ ═══════════
bot.callbackQuery(/^reply:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_ID) return;
  const msgId = ctx.match[1];
  try {
    const msg = await messagesCol.findOne({ _id: new ObjectId(msgId) });
    if (!msg) return ctx.reply('Не найдено.');
    const s = sessions.get(ADMIN_ID) || {};
    s.replyToUserId = msg.fromUserId;
    s.replyMsgId = msgId;
    sessions.set(ADMIN_ID, s);
    await ctx.reply(
      `Напишите ответ для \`${msg.fromUserId}\`. /cancel — отмена.`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    await ctx.reply('⚠️ Ошибка: неверный ID.');
  }
});

// ═══════════ АДМИН: РАССЫЛКА ═══════════
bot.callbackQuery('admin:broadcast', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_ID) return;

  const kb = new InlineKeyboard()
    .text('👥 Всем', 'admin:broadcast:all').row()
    .text('✅ Только платным', 'admin:broadcast:paid').row()
    .text('🎁 Только пробным', 'admin:broadcast:trial').row()
    .text('← Отмена', 'admin:refresh');

  await ctx.reply('📢 *Кому отправить рассылку?*', {
    parse_mode: 'Markdown', reply_markup: kb
  });
});

bot.callbackQuery(/^admin:broadcast:(all|paid|trial)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_ID) return;

  const target = ctx.match[1];
  let query = {};
  if (target === 'paid') query = { paid: true };
  else if (target === 'trial') query = { trialUsed: true, paid: false };

  const s = sessions.get(ADMIN_ID) || {};
  s.broadcastTo = target;
  s.broadcastQuery = query;
  sessions.set(ADMIN_ID, s);

  await ctx.reply(
    `📢 *Рассылка → ${target}*\n\nНапишите текст сообщения.\n❌ /cancel — отмена.`,
    { parse_mode: 'Markdown' }
  );
});

// ═══════════ АДМИН: ВЫДАТЬ ДОСТУП ═══════════
bot.callbackQuery('admin:grant', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_ID) return;

  const s = sessions.get(ADMIN_ID) || {};
  s.awaitingGrant = true;
  sessions.set(ADMIN_ID, s);

  await ctx.reply(
    '🎁 *Выдать доступ*\n\nОтправьте Telegram ID пользователя (число).\n❌ /cancel — отмена.',
    { parse_mode: 'Markdown' }
  );
});

// ═══════════ АДМИН: ЗАБАНИТЬ ═══════════
bot.callbackQuery('admin:ban', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_ID) return;

  const s = sessions.get(ADMIN_ID) || {};
  s.awaitingBan = true;
  sessions.set(ADMIN_ID, s);

  await ctx.reply(
    '🚫 *Забанить*\n\nОтправьте Telegram ID.\n❌ /cancel — отмена.',
    { parse_mode: 'Markdown' }
  );
});

// ═══════════ АДМИН: ЭКСПОРТ CSV ═══════════
bot.callbackQuery('admin:export', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_ID) return;

  const users = await usersCol.find().toArray();

  let csv = 'userId,username,firstName,paid,method,trialUsed,sessions,createdAt,lastSeen\n';
  for (const u of users) {
    csv += [
      u.userId,
      `"${u.username || ''}"`,
      `"${(u.firstName || '').replace(/"/g, '""')}"`,
      u.paid ? 1 : 0,
      u.paymentMethod || '',
      u.trialUsed ? 1 : 0,
      u.sessions || 0,
      u.createdAt?.toISOString() || '',
      u.lastSeen?.toISOString() || ''
    ].join(',') + '\n';
  }

  const filename = `users_${new Date().toISOString().slice(0, 10)}.csv`;
  await ctx.replyWithDocument(
    new InputFile(Buffer.from(csv, 'utf8'), filename),
    { caption: `📤 Экспорт: ${users.length} пользователей` }
  );
});

// ═══════════ ВЫБОР РЕЖИМА ═══════════
bot.callbackQuery(/^mode:(beginner|exam)$/, async (ctx) => {
  const mode = ctx.match[1];
  const userId = ctx.from.id;
  const u = await usersCol.findOne({ userId });

  if (u?.banned) {
    await ctx.answerCallbackQuery({ text: '🚫 Вы заблокированы' });
    return;
  }

  if (!u.paid && u.trialUsed) {
    await ctx.answerCallbackQuery({ text: '🔒 Требуется оплата' });
    return ctx.reply(
      `🔒 *Бесплатная тренировка завершена*\n\nОткройте полный доступ за *${PRICE_USDT} USDT* или *${PRICE_STARS} Stars*.`,
      { parse_mode: 'Markdown', reply_markup: paywallKeyboard() }
    );
  }

  createSession(userId, mode);
  await ctx.answerCallbackQuery();

  const kb = new InlineKeyboard()
    .text('👤 Свидетель', 'st:witness').row()
    .text('🚨 Подозреваемый', 'st:suspect').row()
    .text('⚖️ Обвиняемый', 'st:accused').row()
    .text('🛡️ Потерпевший', 'st:victim').row()
    .text('📋 Истец', 'st:plaintiff').row()
    .text('📋 Ответчик', 'st:defendant');

  await ctx.reply('*Выберите процессуальный статус:*',
    { parse_mode: 'Markdown', reply_markup: kb });
});

// ═══════════ ВЫБОР СТАТУСА ═══════════
bot.callbackQuery(/^st:(witness|suspect|accused|victim|plaintiff|defendant)$/, async (ctx) => {
  const status = ctx.match[1];
  const sess = getSession(ctx.from.id);
  if (!sess) return ctx.answerCallbackQuery({ text: 'Начните с /start' });

  sess.status = status;
  await ctx.answerCallbackQuery();

  const kb = new InlineKeyboard()
    .text('🏪 Кража в магазине', 'sc:theft').row()
    .text('🚗 ДТП', 'sc:accident').row()
    .text('💰 Мошенничество', 'sc:fraud').row()
    .text('🏠 Кража со взломом', 'sc:burglary').row()
    .text('🧑‍⚖️ Свидетель по чужому делу', 'sc:witness_other').row()
    .text('💊 Наркотики', 'sc:drugs').row()
    .text('🪙 Криптовалюта', 'sc:crypto').row()
    .text('🥊 Побои', 'sc:beating').row()
    .text('⚠️ Изнасилование', 'sc:rape').row()
    .text('🏠 Домашнее насилие', 'sc:domestic_violence').row()
    .text('👊 Драка', 'sc:fight').row()
    .text('📝 Свой инцидент', 'sc:custom');

  await ctx.reply(`*${STATUS[status]}*\n\n*Выберите сценарий:*`,
    { parse_mode: 'Markdown', reply_markup: kb });
});

// ═══════════ ВЫБОР СЦЕНАРИЯ ═══════════
bot.callbackQuery(
  /^sc:(theft|accident|fraud|burglary|witness_other|drugs|crypto|beating|rape|domestic_violence|fight|custom)$/,
  async (ctx) => {
    const key = ctx.match[1];
    const sess = getSession(ctx.from.id);
    if (!sess) return ctx.answerCallbackQuery({ text: 'Начните с /start' });
    if (!sess.status) return ctx.answerCallbackQuery({ text: 'Выберите статус' });

    await ctx.answerCallbackQuery();

    if (key === 'custom') {
      sess.awaitingCustomIncident = true;
      await ctx.reply(
        `*${STATUS[sess.status]}*\n\n*Опишите свой инцидент:*\n\n• Что произошло?\n• Когда?\n• Кто участвовал?\n• Что делали вы?\n\n⚠️ Без личных данных.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const scenario = SCENARIOS[key];
    await ctx.reply(
      `*${scenario.emoji} ${scenario.title}*\n\n${scenario.text}\n\n⏳ Начинаю тренировку...`,
      { parse_mode: 'Markdown' }
    );
    await startTraining(ctx, sess, scenario.text);
  }
);

// ═══════════ REPLY-КНОПКИ ═══════════
bot.hears('🎓 Завершить', async (ctx) => { await handleFinish(ctx); });
bot.hears('📊 Итог', async (ctx) => { await handleFinish(ctx); });
bot.hears('💡 Подсказка', async (ctx) => { await handleHint(ctx); });

bot.hears('🛡️ Мои права', async (ctx) => {
  const sess = getSession(ctx.from.id);
  if (!sess || !sess.incident) return ctx.reply('Начните с /start');
  await ctx.reply('🛡️ *Выберите действие:*',
    { parse_mode: 'Markdown', reply_markup: rightsInlineKeyboard() });
});

bot.hears('🔄 Сменить статус', async (ctx) => {
  const kb = new InlineKeyboard()
    .text('👤 Свидетель', 'st:witness').row()
    .text('🚨 Подозреваемый', 'st:suspect').row()
    .text('⚖️ Обвиняемый', 'st:accused').row()
    .text('🛡️ Потерпевший', 'st:victim').row()
    .text('📋 Истец', 'st:plaintiff').row()
    .text('📋 Ответчик', 'st:defendant');
  await ctx.reply('*Выберите новый статус:*',
    { parse_mode: 'Markdown', reply_markup: kb });
});

bot.hears('💬 Написать админу', async (ctx) => {
  const s = sessions.get(ctx.from.id) || {};
  s.chatWithAdmin = true;
  sessions.set(ctx.from.id, s);
  await ctx.reply(
    '💬 *Чат с администратором*\n\nОпишите вопрос.\n\n❌ /cancel — отмена.',
    { parse_mode: 'Markdown' }
  );
});

// ═══════════ INLINE-КНОПКИ ПОД ВОПРОСОМ ═══════════
bot.callbackQuery('hint', async (ctx) => {
  await ctx.answerCallbackQuery();
  await handleHint(ctx);
});

bot.callbackQuery('meaning', async (ctx) => {
  await ctx.answerCallbackQuery();
  await handleMeaning(ctx);
});

bot.callbackQuery('skip_question', async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = getSession(ctx.from.id);
  if (!sess || !sess.incident) return;
  sess.round++;
  await ctx.reply('⏭️ Вопрос пропущен.');
  await askNextQuestion(ctx, sess);
});

bot.callbackQuery('show_laws', async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = getSession(ctx.from.id);
  if (!sess || !sess.lastLaws?.length) {
    return ctx.reply('📚 Нет подобранных статей для этого инцидента.');
  }
  let text = '📚 *Релевантные статьи:*\n\n';
  for (const a of sess.lastLaws) {
    const head = a.code && a.article ? `${a.code}, ${a.article}: ${a.title}` : a.title;
    text += `*${head}*\n${String(a.text).slice(0, 300)}${a.text.length > 300 ? '…' : ''}\n\n`;
  }
  await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.callbackQuery('compare_with_standard', async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = getSession(ctx.from.id);
  if (!sess || !sess.lastEvaluation) {
    return ctx.reply('Нет данных для сравнения.');
  }
  await ctx.reply(`📊 *Ваша последняя оценка:*\n\n${sess.lastEvaluation}`,
    { parse_mode: 'Markdown' });
});

// ═══════════ ПРАВА: МЕНЮ ═══════════
bot.callbackQuery('rights_menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = getSession(ctx.from.id);
  if (!sess || !sess.incident) return ctx.reply('Начните с /start');
  try { await ctx.deleteMessage(); } catch (e) {}
  await ctx.reply('🛡️ *Выберите действие:*',
    { parse_mode: 'Markdown', reply_markup: rightsInlineKeyboard() });
});

bot.callbackQuery('complaint_menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply('📞 *Жалобы и фиксация:*',
    { parse_mode: 'Markdown', reply_markup: complaintsInlineKeyboard() });
});

// ═══════════ ПРАВА: ДЕЙСТВИЯ ═══════════
bot.callbackQuery(
  /^act:(silence|lawyer|break|note|pressure|translator|refuse_sign|clarify)$/,
  async (ctx) => {
    const action = ctx.match[1];
    const sess = getSession(ctx.from.id);
    if (!sess || !sess.incident) {
      return ctx.answerCallbackQuery({ text: 'Начните с /start' });
    }

    await ctx.answerCallbackQuery({ text: '⏳ Готовлю...' });
    sess.actionsUsed = (sess.actionsUsed || 0) + 1;

    try {
      await ctx.replyWithChatAction('typing');
      const result = await callAI(
        buildActionPrompt(action, sess.status, sess.incident, sess.currentQuestion),
        400
      );
      await ctx.reply(result, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error(e);
      await logError(e, ctx.from.id);
      await ctx.reply('⚠️ Ошибка.');
    }
  }
);

// ═══════════ ПРАВА: ЖАЛОБЫ ═══════════
bot.callbackQuery(/^comp:(prosecutor|higher|protocol|document)$/, async (ctx) => {
  const type = ctx.match[1];
  const sess = getSession(ctx.from.id);
  if (!sess || !sess.incident) {
    return ctx.answerCallbackQuery({ text: 'Начните с /start' });
  }

  await ctx.answerCallbackQuery({ text: '⏳ Готовлю...' });

  try {
    await ctx.replyWithChatAction('typing');
    const result = await callAI(
      buildComplaintPrompt(type, sess.status, sess.incident),
      400
    );
    await ctx.reply(result, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(e);
    await logError(e, ctx.from.id);
    await ctx.reply('⚠️ Ошибка.');
  }
});// ═══════════ ОПЛАТА STARS ═══════════
bot.callbackQuery('pay:stars', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.answerCallbackQuery();
  try {
    await ctx.replyWithInvoice(
      'Dopros Trainer KZ — Lifetime Access',
      'Вечный доступ. Без подписок.',
      `stars_${userId}_${Date.now()}`,
      'XTR',
      [{ label: 'Lifetime Access', amount: PRICE_STARS }],
      { provider_token: '' }
    );
  } catch (e) {
    console.error(e);
    await logError(e, userId);
    await ctx.reply('⚠️ Ошибка создания счёта.');
  }
});

// ═══════════ ОПЛАТА USDT ═══════════
bot.callbackQuery('pay:usdt', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.answerCallbackQuery();
  if (!CRYPTO_PAY_TOKEN) {
    return ctx.reply('⚠️ USDT временно недоступен. Используйте Stars.');
  }
  await ctx.reply('💎 Готовлю счёт...');
  try {
    const inv = await createUsdtInvoice(userId);
    await paymentsCol.insertOne({
      userId, method: 'usdt', amount: PRICE_USDT,
      invoiceId: inv.invoice_id, status: 'pending',
      createdAt: new Date()
    });
    const kb = new InlineKeyboard().url('💎 Оплатить USDT', inv.bot_invoice_url);
    await ctx.reply(
      `💎 *Счёт на ${PRICE_USDT} USDT*\n\nНажмите кнопку ниже.`,
      { parse_mode: 'Markdown', reply_markup: kb }
    );
    checkUsdtPayment(ctx, userId, inv.invoice_id, 30);
  } catch (e) {
    console.error(e);
    await logError(e, userId);
    await ctx.reply('⚠️ Ошибка счёта.');
  }
});

async function checkUsdtPayment(ctx, userId, invoiceId, attempts) {
  if (attempts <= 0) return;
  await new Promise(r => setTimeout(r, 10000));
  try {
    const res = await fetch(
      `${CRYPTO_PAY_API}/getInvoices?invoice_ids=${invoiceId}`,
      { headers: { 'Crypto-Pay-API-Token': CRYPTO_PAY_TOKEN } }
    );
    const data = await res.json();
    const inv = data.result?.items?.[0];
    if (inv && inv.status === 'paid') {
      await setUserPaid(userId, 'usdt');
      await paymentsCol.updateOne(
        { invoiceId },
        { $set: { status: 'paid', paidAt: new Date() } }
      );
      try {
        await ctx.api.sendMessage(userId,
          '✅ *Оплата получена!*\n\nОтправьте /start.',
          { parse_mode: 'Markdown' });
      } catch (e) {}
      if (ADMIN_ID) {
        try {
          await ctx.api.sendMessage(ADMIN_ID,
            `💰 *Оплата USDT*\n🆔 \`${userId}\`\n💎 ${PRICE_USDT} USDT`,
            { parse_mode: 'Markdown' });
        } catch (e) {}
      }
      return;
    }
    checkUsdtPayment(ctx, userId, invoiceId, attempts - 1);
  } catch (e) {
    console.error('checkUsdtPayment:', e.message);
    checkUsdtPayment(ctx, userId, invoiceId, attempts - 1);
  }
}

// ═══════════ STARS SUCCESS ═══════════
bot.on('message:successful_payment', async (ctx) => {
  const userId = ctx.from.id;
  const p = ctx.message.successful_payment;
  await setUserPaid(userId, 'stars');
  await paymentsCol.insertOne({
    userId, method: 'stars', amount: p.total_amount,
    currency: 'XTR', telegramChargeId: p.telegram_payment_charge_id,
    status: 'paid', createdAt: new Date()
  });
  if (ADMIN_ID) {
    try {
      await ctx.api.sendMessage(ADMIN_ID,
        `💰 *Stars*\n👤 ${ctx.from.first_name || ''} @${ctx.from.username || '—'}\n🆔 \`${userId}\`\n⭐ ${p.total_amount} XTR`,
        { parse_mode: 'Markdown' });
    } catch (e) {}
  }
  await ctx.reply('✅ *Оплата получена!*\n\nОтправьте /start.',
    { parse_mode: 'Markdown' });
});

// ═══════════ WALLET: ИНСТРУКЦИЯ ═══════════
bot.callbackQuery('wallet:howto', async (ctx) => {
  await ctx.answerCallbackQuery();
  const instruction =
    `💼 *Как оплатить через Telegram Wallet*\n\n` +
    `*ЧАСТЬ 1. КОШЕЛЁК*\n\n` +
    `*Шаг 1.* В поиске Telegram введите *@wallet*.\nВыберите бота с *синей галочкой ✓*.\n\n` +
    `*Шаг 2.* Нажмите *Start* → *Open Wallet*.\n\n` +
    `*Шаг 3.* Установите *PIN-код* (4–6 цифр).\n\n` +
    `*ЧАСТЬ 2. ПОПОЛНЕНИЕ*\n\n` +
    `*Шаг 4.* Нажмите *«+»* → *Add Crypto*.\n\n` +
    `Способы:\n• *P2P Express* — покупка с карты.\n• *Bank Card* — прямая покупка.\n• *Transfer* — с биржи.\n\n` +
    `*ЧАСТЬ 3. ОПЛАТА*\n\n` +
    `*Шаг 5.* Минимум *3 USDT* в кошельке.\n\n` +
    `*Шаг 6.* Вернитесь → *«💎 Оплатить через Wallet»*.\n\n` +
    `*Шаг 7.* Сеть *TRC20* или *TON*.\n\n` +
    `*Шаг 8.* Подтвердите → доступ активируется.\n\n` +
    `⚠️ Комиссия сети 0.5–1 USDT.\nВозврат НЕ производится.`;
  const kb = new InlineKeyboard()
    .text('🚀 Открыть @wallet', 'open_wallet').row()
    .text('💎 Оплатить через Wallet', 'pay:usdt').row()
    .text('💬 Написать админу', 'contact_admin');
  await ctx.reply(instruction, { parse_mode: 'Markdown', reply_markup: kb });
});

bot.callbackQuery('open_wallet', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Ищите @wallet в Telegram' });
  await ctx.reply(
    '🚀 *Откройте @wallet:*\n\n👉 [Открыть @wallet](https://t.me/wallet)\n\nПосле — *💎 Оплатить через Wallet*.',
    { parse_mode: 'Markdown' }
  );
});

bot.callbackQuery('show_privacy', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `🔒 *Политика конфиденциальности*\n\n` +
    `Бот не собирает ФИО, ИИН, адрес, телефон, email, карту.\n\n` +
    `*Храним:* Telegram ID, статус оплаты, время обращения.\n` +
    `*Передаём:* Telegram, Crypto Pay, AI (только текст).\n` +
    `*Удаление:* /delete_me\n\nПодробнее — /privacy.`,
    { parse_mode: 'Markdown' }
  );
});

// ═══════════ ЧАТ С АДМИНОМ ═══════════
bot.callbackQuery('contact_admin', async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = sessions.get(ctx.from.id) || {};
  s.chatWithAdmin = true;
  sessions.set(ctx.from.id, s);
  await ctx.reply(
    '💬 *Чат с администратором*\n\nОпишите вопрос. Простые обработает AI, сложные — передадутся админу.\n\n❌ /cancel — отмена.',
    { parse_mode: 'Markdown' }
  );
});
