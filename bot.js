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
};
