// bot.js — Dopros Trainer KZ v9.1 (обновлённое приветствие)
const { Bot, InlineKeyboard, Keyboard } = require('grammy');
const OpenAI = require('openai');
const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { MongoClient, ObjectId } = require('mongodb');

// ============ CONFIG ============
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = 'deepseek-chat';
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '0');
const CRYPTO_PAY_TOKEN = process.env.CRYPTO_PAY_TOKEN;
const PRICE_STARS = parseInt(process.env.PRICE_STARS || '100');
const PRICE_USDT = parseInt(process.env.PRICE_USDT || '2');

if (!BOT_TOKEN) { console.error('TELEGRAM_BOT_TOKEN missing'); process.exit(1); }
if (!DEEPSEEK_KEY) { console.error('DEEPSEEK_API_KEY missing'); process.exit(1); }
if (!MONGODB_URI) { console.error('MONGODB_URI missing'); process.exit(1); }
if (!ADMIN_ID) { console.error('ADMIN_ID missing'); process.exit(1); }

const ai = new OpenAI({
  apiKey: DEEPSEEK_KEY,
  baseURL: 'https://api.deepseek.com'
});

// ============ DATABASE ============
let db, usersCol, paymentsCol, errorsCol, messagesCol;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('doprosbot');
  usersCol = db.collection('users');
  paymentsCol = db.collection('payments');
  errorsCol = db.collection('errors');
  messagesCol = db.collection('messages');
  console.log('✅ MongoDB connected');
  await usersCol.createIndex({ userId: 1 }, { unique: true });
  await messagesCol.createIndex({ createdAt: -1 });
  await errorsCol.createIndex({ createdAt: -1 });
}

async function getUser(userId) {
  let u = await usersCol.findOne({ userId });
  if (!u) {
    u = { userId, username: null, firstName: null, paid: false, paidAt: null,
          paymentMethod: null, trialUsed: false, trialUsedAt: null,
          sessions: 0, lastSeen: new Date(), createdAt: new Date() };
    await usersCol.insertOne(u);
  } else {
    await usersCol.updateOne({ userId }, { $set: { lastSeen: new Date() } });
  }
  return u;
}

async function setUserPaid(userId, method) {
  await usersCol.updateOne({ userId }, { $set: { paid: true, paidAt: new Date(), paymentMethod: method } });
}

async function markTrialUsed(userId) {
  await usersCol.updateOne({ userId }, { $set: { trialUsed: true, trialUsedAt: new Date() } });
}

async function logError(err, userId) {
  try {
    await errorsCol.insertOne({ message: err.message || String(err), stack: err.stack || null,
      userId: userId || null, createdAt: new Date() });
  } catch (e) { console.error('logError failed:', e.message); }
}

async function saveMessage(fromUserId, text) {
  const r = await messagesCol.insertOne({ fromUserId, text, direction: 'to_admin', replied: false, createdAt: new Date() });
  return r.insertedId;
}

// ============ CRYPTO PAY ============
const CRYPTO_PAY_API = 'https://pay.crypt.bot/api';

async function createUsdtInvoice(userId) {
  const res = await fetch(`${CRYPTO_PAY_API}/createInvoice`, {
    method: 'POST',
    headers: { 'Crypto-Pay-API-Token': CRYPTO_PAY_TOKEN, 'Content-Type': 'application/json' },
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

// ============ LOAD LAWS ============
function loadLaws() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'laws_KZ.json'), 'utf8'));
    return data.articles || [];
  } catch (e) { console.error('laws_KZ.json:', e.message); return []; }
}
const LAWS_KZ = loadLaws();
console.log(`📚 Laws loaded: KZ: ${LAWS_KZ.length}`);

function findRelevantArticles(query, limit = 5) {
  if (!LAWS_KZ.length) return [];
  const q = query.toLowerCase();
  const words = q.replace(/[^\w\sа-яё]/gi, ' ').split(/\s+/).filter(w => w.length > 3);
  const scored = LAWS_KZ.map(art => {
    let score = 0;
    for (const kw of art.keywords) {
      const k = kw.toLowerCase();
      if (q.includes(k)) score += 3;
      for (const w of words) if (k.includes(w) || w.includes(k)) score += 1;
    }
    return { art, score };
  });
  return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.art);
}

// ============ STATUS & SCENARIOS ============
const STATUS = {
  witness: 'Свидетель', suspect: 'Подозреваемый', accused: 'Обвиняемый',
  victim: 'Потерпевший', plaintiff: 'Истец', defendant: 'Ответчик'
};

const SCENARIOS = {
  theft: { emoji: '🏪', title: 'Кража в магазине', text: 'Меня вызвали на допрос как свидетеля по делу о краже в магазине. В магазине пропал телефон. Следователь утверждает, что камеры показали моего брата рядом с витриной. Он спрашивает, что мне известно о брате и о краже.' },
  accident: { emoji: '🚗', title: 'ДТП', text: 'Я стал свидетелем ДТП на перекрестке. Один водитель скрылся с места происшествия. Следователь вызвал меня на допрос и спрашивает, могу ли я описать водителя и обстоятельства.' },
  fraud: { emoji: '💰', title: 'Мошенничество', text: 'Меня вызвали на допрос как свидетеля по делу о мошенничестве. Мою знакомую подозревают в обмане пожилых людей. Следователь спрашивает, знал ли я о её деятельности и получал ли от неё деньги.' },
  burglary: { emoji: '🏠', title: 'Кража со взломом', text: 'В нашем подъезде произошла кража со взломом квартиры соседа. Меня как свидетеля вызвали на допрос. Следователь спрашивает, видел ли я кого-то подозрительного в день кражи.' },
  witness_other: { emoji: '🧑‍⚖️', title: 'Свидетель по чужому делу', text: 'Меня вызвали на допрос как свидетеля по делу о грабеже. Подозреваемый — мой коллега по работе. Следователь спрашивает, что я знаю о его поведении и где он был в день преступления.' },
  custom: { emoji: '📝', title: 'Свой инцидент', text: null }
};

// ============ LANGUAGE GUARD ============
function detectLanguage(text) {
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  const cyr = (text.match(/[а-яА-ЯёЁ]/g) || []).length;
  if (latin + cyr === 0) return 'unknown';
  return latin > cyr ? 'latin' : 'cyrillic';
}
function hasWrongJurisdiction(text) {
  const t = text.toLowerCase();
  if (/конституц[а-я]+ рф|упк рф|ук рф|гпк рф|коап рф/.test(t)) return true;
  if (/stpo|stgb|grundgesetz|zpo|owig/.test(t)) return true;
  return false;
}

// ============ LAWS CONTEXT ============
function buildLawsContext(articles) {
  if (!articles.length) return '(нет найденных статей)';
  return articles.map(a => `\n### ${a.title}\n${a.text}\n`).join('\n');
}

// ============ PROMPTS ============
function buildQuestionPrompt(status, incident, history, laws) {
  return `⚠️ СТРОГО: только РУССКИЙ. ⚠️ ТОЛЬКО законы КАЗАХСТАНА.
⚠️ ОДИН вопрос. БЕЗ анализа.
Страна: Казахстан. Статус: ${STATUS[status]}.
ИНЦИДЕНТ: ${incident}
ДИАЛОГ: ${history}
СТАТЬИ: ${buildLawsContext(laws)}
ФОРМАТ: 🎭 Следователь: [один вопрос на русском]`;
}
function buildEvaluationPrompt(status, incident, history, laws) {
  return `⚠️ ТОЛЬКО РУССКИЙ. ⚠️ ТОЛЬКО законы КАЗАХСТАНА.
Страна: Казахстан. Статус: ${STATUS[status]}.
ИНЦИДЕНТ: ${incident}
ДИАЛОГ: ${history}
СТАТЬИ: ${buildLawsContext(laws)}
ФОРМАТ:
📊 Оценка: [✅ / ⚠️ / ❌]
⚠️ Ошибка: [1 предложение или "нет"]
🎯 Эталон: «[правильная формулировка]»
📚 Статьи: [названия]
💬 Коротко: [1-2 предложения]`;
}
function buildHintPrompt(status, incident, history, laws) {
  return `⚠️ ТОЛЬКО РУССКИЙ. Максимум 2 предложения.
Страна: Казахстан. Статус: ${STATUS[status]}.
ИНЦИДЕНТ: ${incident}
ДИАЛОГ: ${history}
СТАТЬИ: ${buildLawsContext(laws)}
ФОРМАТ: 💡 Подсказка: [максимум 2 предложения]`;
}
function buildMeaningPrompt(question, incident, laws) {
  return `⚠️ ТОЛЬКО РУССКИЙ. Объясни, что следователь имел в виду.
ВОПРОС: "${question}"
ИНЦИДЕНТ: ${incident}
СТАТЬИ: ${buildLawsContext(laws)}
ФОРМАТ:
🤔 Что имел в виду:
• 🎯 Цель: [1 предложение]
• ⚠️ Опасность: [1 предложение]
• 🛡️ Как отвечать: [1-2 предложения]`;
}
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
Ситуация: ${actions[action]}.
Статус: ${STATUS[status]}.
Вопрос: "${question || '(нет)'}"
ИНЦИДЕНТ: ${incident}
ФОРМАТ:
🛡️ *${actions[action]}*
📝 Формулировка: «[фраза]»
⚖️ Основание: [статья]
💡 Совет: [1 предложение]`;
}
function buildComplaintPrompt(type, status, incident) {
  const types = {
    prosecutor: 'жалоба прокурору', higher: 'жалоба в вышестоящий орган',
    protocol: 'внести в протокол', document: 'зафиксировать нарушение'
  };
  return `⚠️ ТОЛЬКО РУССКИЙ. Инструкция: ${types[type]}.
Статус: ${STATUS[status]}. ИНЦИДЕНТ: ${incident}
ФОРМАТ:
📞 *${types[type]}*
📝 Куда/что: [1-2 предложения]
🎯 Как: 1. [шаг] 2. [шаг] 3. [шаг]
⚖️ Основание: [статья]`;
}
function buildSummaryPrompt(status, incident, history, laws, stats) {
  return `⚠️ ТОЛЬКО РУССКИЙ. ⚠️ ТОЛЬКО законы КАЗАХСТАНА.
Статус: ${STATUS[status]}. Статистика: ✅ ${stats.correct}, ⚠️ ${stats.warnings}, ❌ ${stats.errors}.
ИНЦИДЕНТ: ${incident}
ДИАЛОГ: ${history}
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

// ============ ADMIN FAQ ============
const ADMIN_FAQ = `
ЧАСТО ЗАДАВАЕМЫЕ ВОПРОСЫ:
О БОТЕ:
• Что это? — Тренажёр допроса для Казахстана.
• Это консультация юриста? — НЕТ.
• Язык — только русский.
• Работает 24/7.
ОПЛАТА:
• Сколько стоит? — 100 Stars ИЛИ 2 USDT.
• Что даёт? — Вечный доступ, без подписок.
• Бесплатно? — 1 тренировка.
• Возврат? — НЕТ.
ФУНКЦИИ:
• Сценарии: кража, ДТП, мошенничество, взлом, свидетель + свой.
• Кнопка «🛡️ Мои права» — 8 действий.
ПРИВАТНОСТЬ:
• Собираем: Telegram ID и статус оплаты.
• /privacy — политика.
• /delete_me — удаление.
ПОДДЕРЖКА:
• Время ответа — до 24 часов.
`;

function buildAdminReplyPrompt(userMessage, username) {
  return `Ты — администратор бота "Dopros Trainer KZ".
Пользователь: ${username || 'без username'}
СООБЩЕНИЕ: "${userMessage}"

${ADMIN_FAQ}

ПРАВИЛА:
1. Простые вопросы (оплата, функции, ошибки) — отвечай сам, макс 4 предложения.
2. Сложные (возврат, баг, жалоба, юр. вопрос, реклама) — ответь ТОЛЬКО: «Передал ваш вопрос администратору. Он ответит лично в течение 24 часов.»
3. Не обещай возврат. Не давай юр. консультаций.
4. На «вы», вежливо, на русском.

ФОРМАТ:
CATEGORY: [SIMPLE или COMPLEX]
REPLY: [текст]

Если COMPLEX — REPLY всегда: «Передал ваш вопрос администратору. Он ответит лично в течение 24 часов.»
`;
}

// ============ SESSIONS ============
const sessions = new Map();

// ============ KEYBOARDS ============
function mainReplyKeyboard() {
  return new Keyboard()
    .text('🎓 Завершить').text('💡 Подсказка').row()
    .text('🛡️ Мои права').text('📊 Итог').row()
    .text('💬 Написать админу').text('🔄 Сменить статус').resized().persistent();
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

// ============ BOT ============
const bot = new Bot(BOT_TOKEN);
bot.catch(async (err) => {
  console.error('Bot error:', err);
  await logError(err, err.ctx?.from?.id);
});

// ============ AI CALL ============
async function callAI(prompt, maxTokens, attempt = 1) {
  let text = '';
  try {
    const r = await ai.chat.completions.create({
      model: MODEL, messages: [{ role: 'user', content: prompt }],
      temperature: 0.5, max_tokens: maxTokens
    });
    text = r.choices[0].message.content || '';
  } catch (e) {
    const is429 = e.message && (e.message.includes('429') || e.message.includes('rate') || e.message.includes('quota'));
    if (is429 && attempt < 3) {
      const wait = attempt * 15;
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
        temperature: 0.2, max_tokens: maxTokens
      });
      const rt = retry.choices[0].message.content || '';
      if (!hasWrongJurisdiction(rt)) text = rt;
    } catch (e) {}
  }
  return text;
}

// ============ /start — НОВОЕ ПРИВЕТСТВИЕ ============
bot.command('start', async (ctx) => {
  const userId = ctx.from.id;
  await getUser(userId);
  const u = await usersCol.findOne({ userId });

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
    '• 5 сценариев (кража, ДТП, мошенничество, взлом, свидетель)\n' +
    '• 6 процессуальных статусов\n' +
    '• 8 процессуальных действий\n' +
    '• Итоговая оценка\n\n' +
    '━━━━━━━━━━━━━━━━━━━━\n\n' +
    '🎁 *Первая тренировка — бесплатно*\n' +
    '🔒 Персональные данные не собираются\n\n' +
    '⚠️ Это тренажёр, не замена адвоката\n\n' +
    '*Выберите режим:*';

  if (!u.paid && !u.trialUsed) {
    sessions.delete(userId);
    await ctx.reply(WELCOME, {
      parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard().text('🎓 Новичок', 'mode:beginner').row().text('📝 Экзамен', 'mode:exam')
    });
    return;
  }

  if (!u.paid && u.trialUsed) {
    await ctx.reply(
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
    return;
  }

  sessions.delete(userId);
  await ctx.reply(
    '⚖️ *Dopros Trainer KZ*\n\n' +
    '✅ *Доступ активен навсегда*\n\n' +
    '━━━━━━━━━━━━━━━━━━━━\n\n' +
    '*Выберите режим:*',
    { parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard().text('🎓 Новичок', 'mode:beginner').row().text('📝 Экзамен', 'mode:exam') }
  );
});

// ============ /privacy ============
bot.command('privacy', async (ctx) => {
  await ctx.reply(
    `🔒 *Политика конфиденциальности*\n\n` +
    `Бот *не собирает* персональные данные:\n• ФИО, ИИН, адрес, телефон\n• Email, карта, паспорт\n\n` +
    `*Что хранится:*\n• Telegram ID\n• Username (публичный)\n• Статус оплаты и сумма\n• Дата последнего обращения\n\n` +
    `*Кому передаются:*\n• Telegram — работа бота\n• Crypto Pay — приём USDT\n• AI — только текст сообщений\n\n` +
    `*Хранение:* до удаления.\n*Удаление:* /delete_me\n\n` +
    `Используя бота, вы соглашаетесь с политикой.`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('delete_me', async (ctx) => {
  const kb = new InlineKeyboard()
    .text('❌ Да, удалить', 'confirm_delete').row()
    .text('← Отмена', 'cancel_delete');
  await ctx.reply(
    `⚠️ *Удаление данных*\n\n` +
    `Будут удалены:\n• Telegram ID\n• Статус оплаты\n• История обращений\n\n` +
    `⚠️ Платный доступ будет утерян без возврата.\n\nПродолжить?`,
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
      try { await ctx.api.sendMessage(ADMIN_ID, `🗑 Пользователь удалил данные\n🆔 \`${userId}\``, { parse_mode: 'Markdown' }); } catch (e) {}
    }
    await ctx.reply('✅ *Данные удалены*\n\nTelegram ID удалён из базы. Сессия сброшена.', { parse_mode: 'Markdown' });
  } catch (e) { console.error(e); await ctx.reply('⚠️ Ошибка удаления. Напишите админу.'); }
});

bot.callbackQuery('cancel_delete', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply('❌ Удаление отменено.');
});

bot.callbackQuery('show_privacy', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `🔒 *Политика конфиденциальности*\n\n` +
    `Бот не собирает ФИО, ИИН, адрес, телефон, email, карту.\n\n` +
    `*Храним:* Telegram ID, статус оплаты, время обращения.\n` +
    `*Передаём:* Telegram, Crypto Pay, AI (только текст).\n` +
    `*Удаление:* /delete_me\n\n` +
    `Подробнее — /privacy.`,
    { parse_mode: 'Markdown' }
  );
});

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

// ============ /admin ============
bot.command('admin', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ Нет доступа.');
  const total = await usersCol.countDocuments();
  const paid = await usersCol.countDocuments({ paid: true });
  const trial = await usersCol.countDocuments({ trialUsed: true, paid: false });
  const notStarted = await usersCol.countDocuments({ trialUsed: false, paid: false });
  const errors = await errorsCol.countDocuments();
  const unreadMsgs = await messagesCol.countDocuments({ replied: false });
  const revenue = await paymentsCol.aggregate([
    { $match: { status: 'paid' } },
    { $group: { _id: '$method', total: { $sum: '$amount' }, count: { $sum: 1 } } }
  ]).toArray();

  let revText = '';
  for (const r of revenue) revText += `• ${r._id}: ${r.count} × ${r.total}\n`;

  const kb = new InlineKeyboard()
    .text('👥 Пользователи', 'admin:users').row()
    .text('❌ Ошибки', 'admin:errors').row()
    .text('💬 Сообщения', 'admin:messages').row()
    .text('🔄 Обновить', 'admin:refresh');

  await ctx.reply(
    `🔐 *АДМИН-ПАНЕЛЬ*\n\n` +
    `👥 Всего: ${total}\n✅ Оплатили: ${paid}\n🎁 Пробных: ${trial}\n⚪ Не начали: ${notStarted}\n\n` +
    `❌ Ошибок: ${errors}\n💬 Непрочитанных: ${unreadMsgs}\n\n` +
    `💰 *Доходы:*\n${revText || '(нет)'}`,
    { parse_mode: 'Markdown', reply_markup: kb }
  );
});

bot.callbackQuery('admin:refresh', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.deleteMessage();
  await bot.api.sendMessage(ctx.chat.id, 'Обновлено. Напишите /admin.');
});

bot.callbackQuery('admin:users', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_ID) return;
  const users = await usersCol.find().sort({ createdAt: -1 }).limit(10).toArray();
  let text = '👥 *Последние 10:*\n\n';
  for (const u of users) {
    const status = u.paid ? '✅' : (u.trialUsed ? '🎁' : '⚪');
    text += `${status} ${u.firstName || '—'} @${u.username || '—'}\n   ID: \`${u.userId}\`\n\n`;
  }
  await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.callbackQuery('admin:errors', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_ID) return;
  const errs = await errorsCol.find().sort({ createdAt: -1 }).limit(10).toArray();
  let text = '❌ *Последние 10 ошибок:*\n\n';
  for (const e of errs) text += `• \`${e.message.slice(0, 100)}\`\n  (${e.createdAt.toISOString().slice(0, 19)})\n\n`;
  await ctx.reply(text || 'Ошибок нет.', { parse_mode: 'Markdown' });
});

bot.callbackQuery('admin:messages', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_ID) return;
  const msgs = await messagesCol.find({ replied: false }).sort({ createdAt: -1 }).limit(10).toArray();
  if (!msgs.length) return ctx.reply('Нет новых сообщений.');
  for (const m of msgs) {
    const kb = new InlineKeyboard().text('↩️ Ответить', `reply:${m._id}`);
    await ctx.reply(`💬 *От* \`${m.fromUserId}\`:\n\n${m.text}`, { parse_mode: 'Markdown', reply_markup: kb });
  }
});

bot.callbackQuery(/^reply:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from.id !== ADMIN_ID) return;
  const msgId = ctx.match[1];
  const msg = await messagesCol.findOne({ _id: new ObjectId(msgId) });
  if (!msg) return ctx.reply('Не найдено.');
  sessions.set(ADMIN_ID, { ...(sessions.get(ADMIN_ID) || {}), replyToUserId: msg.fromUserId, replyMsgId: msgId });
  await ctx.reply(`Напишите ответ для \`${msg.fromUserId}\`. /cancel для отмены.`, { parse_mode: 'Markdown' });
});

// ============ PAY: STARS ============
bot.callbackQuery('pay:stars', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.answerCallbackQuery();
 
// ============ MODE ============
bot.callbackQuery(/^mode:(beginner|exam)$/, async (ctx) => {
  const mode = ctx.match[1];
  sessions.set(ctx.from.id, {
    mode, status: null, incident: null, history: [],
    round: 0, correct: 0, warnings: 0, errors: 0, actionsUsed: 0,
    currentQuestion: null, lastLaws: [], lastEvaluation: null, lastUserAnswer: null
  });
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard()
    .text('👤 Свидетель', 'st:witness').row()
    .text('🚨 Подозреваемый', 'st:suspect').row()
    .text('⚖️ Обвиняемый', 'st:accused').row()
    .text('🛡️ Потерпевший', 'st:victim').row()
    .text('📋 Истец', 'st:plaintiff').row()
    .text('📋 Ответчик', 'st:defendant');
  await ctx.reply('*Выберите процессуальный статус:*', { parse_mode: 'Markdown', reply_markup: kb });
});

// ============ STATUS ============
bot.callbackQuery(/^st:(witness|suspect|accused|victim|plaintiff|defendant)$/, async (ctx) => {
  const status = ctx.match[1];
  const sess = sessions.get(ctx.from.id);
  if (!sess) return ctx.answerCallbackQuery({ text: 'Начните с /start' });
  sess.status = status;
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard()
    .text('🏪 Кража в магазине', 'sc:theft').row()
    .text('🚗 ДТП', 'sc:accident').row()
    .text('💰 Мошенничество', 'sc:fraud').row()
    .text('🏠 Кража со взломом', 'sc:burglary').row()
    .text('🧑‍⚖️ Свидетель по чужому делу', 'sc:witness_other').row()
    .text('📝 Свой инцидент', 'sc:custom');
  await ctx.reply(`*${STATUS[status]}*\n\n*Выберите сценарий:*`, { parse_mode: 'Markdown', reply_markup: kb });
});

// ============ SCENARIO ============
bot.callbackQuery(/^sc:(theft|accident|fraud|burglary|witness_other|custom)$/, async (ctx) => {
  const key = ctx.match[1];
  const sess = sessions.get(ctx.from.id);
  if (!sess) return ctx.answerCallbackQuery({ text: 'Начните с /start' });
  await ctx.answerCallbackQuery();
  if (key === 'custom') {
    await ctx.reply(`*${STATUS[sess.status]}*\n\n*Опишите свой инцидент:*\n\n• Что произошло?\n• Когда?\n• Кто участвовал?\n• Что делали вы?\n\n⚠️ Без личных данных.`);
    return;
  }
  const scenario = SCENARIOS[key];
  await ctx.reply(`*${scenario.emoji} ${scenario.title}*\n\n${scenario.text}\n\n⏳ Начинаю тренировку...`);
  await startTraining(ctx, sess, scenario.text);
});

// ============ START TRAINING ============
async function startTraining(ctx, sess, incidentText) {
  sess.incident = incidentText;
  sess.history = [{ role: 'user', content: 'Инцидент: ' + incidentText }];
  sess.round = 1;
  try { await usersCol.updateOne({ userId: ctx.from.id }, { $inc: { sessions: 1 } }); } catch (e) {}
  const relevant = findRelevantArticles(incidentText, 5);
  sess.lastLaws = relevant;
  try {
    await ctx.replyWithChatAction('typing');
    const question = await callAI(buildQuestionPrompt(sess.status, sess.incident, 'Инцидент: ' + incidentText, relevant), 500);
    sess.currentQuestion = question;
    sess.history.push({ role: 'assistant', content: question });
    await ctx.reply('⚖️ *Тренажёр запущен.*\n\nКнопки внизу — быстрые действия.', { parse_mode: 'Markdown', reply_markup: mainReplyKeyboard() });
    await ctx.reply(progressBar(sess), { parse_mode: 'Markdown' });
    await ctx.reply(question, { parse_mode: 'Markdown', reply_markup: questionInlineKeyboard() });
  } catch (e) {
    console.error(e);
    await logError(e, ctx.from.id);
    await ctx.reply('⚠️ Ошибка ИИ. Попробуйте /start заново.');
  }
}

// ============ Reply keyboard ============
bot.hears('🎓 Завершить', async (ctx) => { await handleFinish(ctx); });
bot.hears('💡 Подсказка', async (ctx) => { await handleHint(ctx); });
bot.hears('📊 Итог', async (ctx) => { await handleFinish(ctx); });
bot.hears('🛡️ Мои права', async (ctx) => {
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.incident) return ctx.reply('Начните с /start');
  await ctx.reply('🛡️ *Выберите действие:*', { parse_mode: 'Markdown', reply_markup: rightsInlineKeyboard() });
});
bot.hears('🔄 Сменить статус', async (ctx) => {
  const kb = new InlineKeyboard()
    .text('👤 Свидетель', 'st:witness').row()
    .text('🚨 Подозреваемый', 'st:suspect').row()
    .text('⚖️ Обвиняемый', 'st:accused').row()
    .text('🛡️ Потерпевший', 'st:victim').row()
    .text('📋 Истец', 'st:plaintiff').row()
    .text('📋 Ответчик', 'st:defendant');
  await ctx.reply('*Выберите новый статус:*', { parse_mode: 'Markdown', reply_markup: kb });
});

// ============ INLINE handlers ============
bot.callbackQuery('hint', async (ctx) => { await ctx.answerCallbackQuery(); await handleHint(ctx); });
async function handleHint(ctx) {
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.incident) return ctx.reply('Начните с /start');
  if (sess.mode === 'exam') return ctx.reply('💡 В режиме экзамена подсказки отключены.');
  await ctx.replyWithChatAction('typing');
  try {
    const lastQ = sess.currentQuestion || '';
    const relevant = findRelevantArticles(sess.incident + ' ' + lastQ, 3);
    const hist = sess.history.map(m => (m.role === 'user' ? '👤 ' : '🎭 ') + m.content).join('\n\n');
    const answer = await callAI(buildHintPrompt(sess.status, sess.incident, hist, relevant), 300);
    await ctx.reply(answer, { parse_mode: 'Markdown' });
  } catch (e) { await ctx.reply('⚠️ Ошибка подсказки.'); }
}

bot.callbackQuery('meaning', async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.currentQuestion) return ctx.reply('Начните с /start');
  await ctx.replyWithChatAction('typing');
  try {
    const relevant = findRelevantArticles(sess.currentQuestion, 3);
    const answer = await callAI(buildMeaningPrompt(sess.currentQuestion, sess.incident, relevant), 500);
    await ctx.reply(answer, { parse_mode: 'Markdown' });
  } catch (e) { await ctx.reply('⚠️ Ошибка разбора.'); }
});

bot.callbackQuery('rights_menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.incident) return ctx.reply('Начните с /start');
  await ctx.reply('🛡️ *Выберите действие:*', { parse_mode: 'Markdown', reply_markup: rightsInlineKeyboard() });
});

bot.callbackQuery(/^act:(silence|lawyer|break|note|pressure|translator|refuse_sign|clarify)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const action = ctx.match[1];
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.incident) return ctx.reply('Начните с /start');
  sess.actionsUsed = (sess.actionsUsed || 0) + 1;
  await ctx.replyWithChatAction('typing');
  try {
    const answer = await callAI(buildActionPrompt(action, sess.status, sess.incident, sess.currentQuestion), 500);
    await ctx.reply(answer, { parse_mode: 'Markdown' });
    await ctx.reply('Продолжайте тренировку.');
  } catch (e) { await ctx.reply('⚠️ Ошибка.'); }
});

bot.callbackQuery('complaint_menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.incident) return ctx.reply('Начните с /start');
  await ctx.reply('📞 *Жалобы и фиксация:*', { parse_mode: 'Markdown', reply_markup: complaintsInlineKeyboard() });
});

bot.callbackQuery(/^comp:(prosecutor|higher|protocol|document)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const type = ctx.match[1];
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.incident) return ctx.reply('Начните с /start');
  await ctx.replyWithChatAction('typing');
  try {
    const answer = await callAI(buildComplaintPrompt(type, sess.status, sess.incident), 500);
    await ctx.reply(answer, { parse_mode: 'Markdown' });
  } catch (e) { await ctx.reply('⚠️ Ошибка.'); }
});

bot.callbackQuery('show_laws', async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.lastLaws || !sess.lastLaws.length) return ctx.reply('📚 Статьи не подобраны.');
  let text = '📚 *Статьи:*\n\n';
  for (const a of sess.lastLaws) text += `*${a.title}*\n${a.text}\n\n`;
  await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.callbackQuery('compare_with_standard', async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.lastEvaluation || !sess.lastUserAnswer) return ctx.reply('📊 Нечего сравнивать.');
  const match = sess.lastEvaluation.match(/🎯 Эталон: «(.+?)»/s);
  const standard = match ? match[1] : '(не найдено)';
  await ctx.reply(
    `📊 *Сравнение с эталоном*\n\n👤 *Ваш ответ:*\n«${sess.lastUserAnswer}»\n\n🎯 *Эталон:*\n«${standard}»\n\n💡 Точность, ссылка на статью, краткость.`,
    { parse_mode: 'Markdown' });
});

bot.callbackQuery('skip_question', async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.incident) return ctx.reply('Начните с /start');
  sess.round++;
  sess.errors++;
  sess.history.push({ role: 'user', content: '[Пропущен вопрос]' });
  await nextQuestion(ctx, sess);
});

bot.command('reset', async (ctx) => {
  sessions.delete(ctx.from.id);
  await ctx.reply('Сброшено. Напишите /start.');
});

bot.command('finish', async (ctx) => { await handleFinish(ctx); });
async function handleFinish(ctx) {
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.incident) return ctx.reply('Нет активной сессии.');
  await ctx.replyWithChatAction('typing');
  try {
    const hist = sess.history.map(m => (m.role === 'user' ? '👤 ' : '🎭 ') + m.content).join('\n\n');
    const relevant = findRelevantArticles(sess.incident + ' ' + hist, 5);
    const summary = await callAI(buildSummaryPrompt(sess.status, sess.incident, hist, relevant, sess), 1200);
    await ctx.reply(summary, { parse_mode: 'Markdown' });
    await ctx.reply('Напишите /start для новой тренировки.');
    sessions.delete(ctx.from.id);
  } catch (e) { await ctx.reply('⚠️ Ошибка формирования итога.'); }
}

async function nextQuestion(ctx, sess) {
  await ctx.replyWithChatAction('typing');
  try {
    const hist = sess.history.map(m => (m.role === 'user' ? '👤 ' : '🎭 ') + m.content).join('\n\n');
    const relevant = findRelevantArticles(sess.incident + ' ' + hist, 5);
    sess.lastLaws = relevant;
    const question = await callAI(buildQuestionPrompt(sess.status, sess.incident, hist, relevant), 500);
    sess.currentQuestion = question;
    sess.history.push({ role: 'assistant', content: question });
    await ctx.reply(progressBar(sess), { parse_mode: 'Markdown' });
    await ctx.reply(question, { parse_mode: 'Markdown', reply_markup: questionInlineKeyboard() });
  } catch (e) { await ctx.reply('⚠️ ИИ недоступен. Подождите 30 секунд.'); }
} ) ;

// ============ MAIN TEXT ============
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;
  const userId = ctx.from.id;
  const sess = sessions.get(userId);

  // Admin reply
  if (userId === ADMIN_ID && sess?.replyToUserId) {
    try {
      await bot.api.sendMessage(sess.replyToUserId, `💬 *Ответ от администратора:*\n\n${text}`, { parse_mode: 'Markdown' });
      await messagesCol.updateOne({ _id: new ObjectId(sess.replyMsgId) }, { $set: { replied: true, repliedAt: new Date(), replyText: text } });
      await ctx.reply('✅ Ответ отправлен.');
    } catch (e) { await ctx.reply('⚠️ Не удалось: ' + e.message); }
    sess.replyToUserId = null;
    sess.replyMsgId = null;
    return;
  }

  // Chat with admin (AI-first)
  if (sess?.chatWithAdmin) {
    sess.chatWithAdmin = false;
    await saveMessage(userId, text);
    await ctx.replyWithChatAction('typing');
    try {
      const username = ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name || null;
      const prompt = buildAdminReplyPrompt(text, username);
      const aiResp = await ai.chat.completions.create({
        model: MODEL, messages: [{ role: 'user', content: prompt }],
        temperature: 0.3, max_tokens: 400
      });
      const raw = aiResp.choices[0].message.content || '';
      const catMatch = raw.match(/CATEGORY:\s*(SIMPLE|COMPLEX)/i);
      const replyMatch = raw.match(/REPLY:\s*([\s\S]+)/i);
      const category = catMatch ? catMatch[1].toUpperCase() : 'COMPLEX';
      const replyText = replyMatch ? replyMatch[1].trim() : 'Передал ваш вопрос администратору. Он ответит лично в течение 24 часов.';
      await ctx.reply(replyText);

      if (ADMIN_ID) {
        const adminText = category === 'COMPLEX'
          ? `🚨 *СЛОЖНЫЙ ВОПРОС*\n\n👤 ${ctx.from.first_name || ''} ${username || ''}\n🆔 \`${userId}\`\n\n💬 ${text}\n\n🤖 «${replyText}»`
          : `✅ *Простой вопрос*\n\n👤 ${ctx.from.first_name || ''} ${username || ''}\n🆔 \`${userId}\`\n\n💬 ${text}\n\n🤖 ${replyText}`;
        const kb = new InlineKeyboard();
        if (category === 'COMPLEX') {
          const lastMsg = await messagesCol.findOne({ fromUserId: userId }, { sort: { createdAt: -1 } });
          if (lastMsg) kb.text('↩️ Ответить лично', `reply:${lastMsg._id}`);
        }
        try { await ctx.api.sendMessage(ADMIN_ID, adminText, { parse_mode: 'Markdown', reply_markup: kb }); } catch (e) {}
      }
    } catch (e) {
      console.error(e);
      await logError(e, userId);
      await ctx.reply('⚠️ Не удалось обработать. Администратор ответит лично.');
    }
    return;
  }

  // Access check
  const u = await getUser(userId);
  if (!u.paid && u.trialUsed && !sess?.incident) {
    return ctx.reply('🔒 *Доступ заблокирован*\n\nОплатите:', { parse_mode: 'Markdown', reply_markup: paywallKeyboard() });
  }

  const labels = ['🎓 Завершить', '💡 Подсказка', '📊 Итог', '🛡️ Мои права', '💬 Написать админу', '🔄 Сменить статус'];
  if (labels.includes(text)) return;

  if (!sess) return ctx.reply('Начните с /start');
  if (!sess.status) return ctx.reply('Выберите статус: /start');

  if (!sess.incident) {
    if (!u.paid && !u.trialUsed) await markTrialUsed(userId);
    await startTraining(ctx, sess, text);
    return;
  }

  sess.history.push({ role: 'user', content: text });
  sess.lastUserAnswer = text;
  await ctx.reply('⏳ Анализирую ответ...');
  const lastQ = sess.currentQuestion || '';
  const relevant = findRelevantArticles(lastQ + ' ' + text, 5);
  sess.lastLaws = relevant;

  try {
    await ctx.replyWithChatAction('typing');
    const hist = sess.history.map(m => (m.role === 'user' ? '👤 ' : '🎭 ') + m.content).join('\n\n');
    const evaluation = await callAI(buildEvaluationPrompt(sess.status, sess.incident, hist, relevant), 700);
    sess.lastEvaluation = evaluation;
    if (evaluation.includes('📊 Оценка: ✅')) sess.correct++;
    else if (evaluation.includes('📊 Оценка: ⚠️')) sess.warnings++;
    else if (evaluation.includes('📊 Оценка: ❌')) sess.errors++;
    sess.round++;
    await ctx.reply(evaluation, { parse_mode: 'Markdown', reply_markup: afterEvalInlineKeyboard() });
    await nextQuestion(ctx, sess);
  } catch (e) {
    console.error(e);
    await logError(e, userId);
    await ctx.reply('⚠️ ИИ недоступен. Подождите 30 секунд.');
  }
});

// ============ CRYPTO PAY WEBHOOK ============
const app = express();
app.use(express.json());

app.post('/api/webhook', async (req, res) => {
  try {
    const update = req.body;
    if (update.update_type === 'invoice_paid') {
      const inv = update.payload;
      let payload = {};
      try { payload = JSON.parse(inv.payload || '{}'); } catch (e) {}
      const userId = payload.userId;
      if (userId) {
        await setUserPaid(userId, 'usdt');
        await paymentsCol.updateOne({ invoiceId: inv.invoice_id }, { $set: { status: 'paid', paidAt: new Date() } });
        try { await bot.api.sendMessage(userId, '✅ *Оплата USDT получена!*\n\nДоступ активирован навсегда. Отправьте /start.', { parse_mode: 'Markdown' }); } catch (e) {}
        if (ADMIN_ID) {
          try { await bot.api.sendMessage(ADMIN_ID, `💰 *Оплата USDT*\n👤 \`${userId}\`\n💎 ${inv.amount} USDT`, { parse_mode: 'Markdown' }); } catch (e) {}
        }
      }
    }
    res.sendStatus(200);
  } catch (e) { console.error('Webhook error:', e); res.sendStatus(500); }
});

app.get('/', (req, res) => res.send('Dopros Trainer KZ v9.1 running'));

// ============ START ============
let retryCount = 0;
const MAX_RETRIES = 10;

async function startBot() {
  try {
    await connectDB();
    await bot.start({
      drop_pending_updates: true,
      onStart: (bi) => {
        console.log(`🚀 Dopros Trainer KZ v9.1 started as @${bi.username}`);
        retryCount = 0;
      }
    });
  } catch (e) {
    const is409 = e.message && e.message.includes('409');
    if (is409 && retryCount < MAX_RETRIES) {
      retryCount++;
      const wait = Math.min(30 * retryCount, 120);
      console.log(`⚠️ 409. Retry in ${wait}s...`);
      setTimeout(startBot, wait * 1000);
    } else {
      console.error('❌ Fatal:', e.message);
      process.exit(1);
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('HTTP server on port ' + PORT);
  startBot();
}); 
