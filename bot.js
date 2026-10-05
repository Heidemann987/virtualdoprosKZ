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
      }
