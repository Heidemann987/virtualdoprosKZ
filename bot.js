// bot.js — Dopros Trainer KZ v9 (MongoDB + Stars + USDT + Admin + AI-чат)
const { Bot, InlineKeyboard, Keyboard } = require('grammy');
const OpenAI = require('openai');
const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { MongoClient, ObjectId } = require('mongodb');

// ============ CONFIG ============
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '0');
const CRYPTO_PAY_TOKEN = process.env.CRYPTO_PAY_TOKEN;
const PRICE_STARS = parseInt(process.env.PRICE_STARS || '100');
const PRICE_USDT = parseInt(process.env.PRICE_USDT || '2');

if (!BOT_TOKEN) { console.error('TELEGRAM_BOT_TOKEN missing'); process.exit(1); }
if (!OPENROUTER_KEY) { console.error('OPENROUTER_API_KEY missing'); process.exit(1); }
if (!MONGODB_URI) { console.error('MONGODB_URI missing'); process.exit(1); }
if (!ADMIN_ID) { console.error('ADMIN_ID missing'); process.exit(1); }

const ai = new OpenAI({
  apiKey: OPENROUTER_KEY,
  baseURL: 'https://openrouter.ai/api/v1'
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
• Способы — Stars и USDT.

ФУНКЦИИ:
• Сценарии: кража, ДТП, мошенничество, взлом, свидетель + свой.
• Кнопка «🛡️ Мои права» — 8 действий.
• Кнопка «📞 Жалобы» — прокурор, вышестоящий, протокол.

ПРОБЛЕМЫ:
• Бот не отвечает — подождите 30–60 сек.
• Ошибка ИИ — /start заново.
• Ошибка оплаты — напишите админу.

ПРИВАТНОСТЬ:
• Собираем: Telegram ID и статус оплаты.
• /privacy — политика.
• /delete_me — удаление.

ПОДДЕРЖКА:
• Время ответа — до 24 часов.
• Только через чат.

ПОДПИСКА:
• Нет. Единый платёж.
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

// ============ /start ============
bot.command('start', async (ctx) => {
  const userId = ctx.from.id;
  await getUser(userId);
  const u = await usersCol.findOne({ userId });

  if (!u.paid && !u.trialUsed) {
    sessions.delete(userId);
    await ctx.reply(
      '⚖️ *Тренажёр допроса (Казахстан)*\n\n' +
      '🎁 *У вас 1 бесплатная тренировка.*\n' +
      '⚠️ Это тренажёр, не замена адвоката.\n\n' +
      '🔒 Персональные данные не собираются. /privacy\n\n' +
      'Выберите режим:',
      { parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard().text('🎓 Новичок', 'mode:beginner').row().text('📝 Экзамен', 'mode:exam') }
    );
    return;
  }

  if (!u.paid && u.trialUsed) {
    await ctx.reply(
      '🔒 *Бесплатная попытка использована*\n\n' +
      'Для продолжения — оплатите доступ:\n' +
      `• ⭐ Telegram Stars: ${PRICE_STARS}\n` +
      `• 💎 USDT: ${PRICE_USDT}\n\n` +
      '*Вечный доступ. Без подписок.*',
      { parse_mode: 'Markdown', reply_markup: paywallKeyboard() }
    );
    return;
  }

  sessions.delete(userId);
  await ctx.reply(
    '⚖️ *Тренажёр допроса (Казахстан)*\n\n✅ Доступ активен.\n\nВыберите режим:',
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

// ============ /delete_me ============
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
      try {
        await ctx.api.sendMessage(ADMIN_ID, `🗑 Пользователь удалил данные\n🆔 \`${userId}\``, { parse_mode: 'Markdown' });
      } catch (e) {}
    }
    await ctx.reply('✅ *Данные удалены*\n\nTelegram ID удалён из базы. Сессия сброшена.', { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(e);
    await ctx.reply('⚠️ Ошибка удаления. Напишите админу.');
  }
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
    '⚖️ *Тренажёр допроса*\n\n' +
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
