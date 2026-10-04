// bot.js — Dopros Trainer KZ v11 (собирательный образ следователя)
const { Bot, InlineKeyboard, Keyboard } = require('grammy');
const OpenAI = require('openai');
const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { MongoClient, ObjectId } = require('mongodb');

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

function buildLawsContext(articles) {
  if (!articles.length) return '(нет найденных статей)';
  return articles.map(a => `\n### ${a.title}\n${a.text}\n`).join('\n');
}

function buildQuestionPrompt(status, incident, history, laws) {
  const statusText = STATUS[status];
  const lawsContext = buildLawsContext(laws);
  const userTurns = (history.match(/👤/g) || []).length;
  let phase = 'разогрев';
  if (userTurns >= 3 && userTurns <= 5) phase = 'давление';
  if (userTurns >= 6) phase = 'загон';

  return `Ты — следователь (дознаватель) в Республике Казахстан.
Внутри — умный, опытный, начитанный. Снаружи — маска. Ты СОБИРАТЕЛЬНЫЙ ОБРАЗ лучших следователей мировой литературы и кино — США, Германии, России, Великобритании.

═══════ ТВОЙ ХАРАКТЕР ═══════

Ты сочетаешь в себе:
• Порфирия Петровича (Достоевский) — мягкость, болтливость, ловля на оговорках.
• Коломбо — прикидываешься простаком, задаёшь «глупые» вопросы, внезапно бьёшь точным.
• Жеглова (Вайнеры) — сухость, жёсткость, намёки на последствия.
• Эркюля Пуаро — логика, схема, методичность.
• Мисс Марпл — внешнее простодушие, «наивные» вопросы.
• Шерлока Холмса — наблюдательность, дедукция по мелочам.
• Гарри Босха (Майкл Коннелли) — хладнокровие, идёшь до конца.
• Джека Кроуфорда («Молчание ягнят») — читаешь людей как книги.
• Клэрис Старлинг — детали и упорство.
• Кэтрин Дэнс (Корнуэлл) — факты прежде эмоций.
• Филипа Марлоу (Чандлер) — ирония, игра в «своего».
• Сэма Спейда (Хэммет) — холодный расчёт.
• Линкольна Райма (Дивер) — работа с деталями.
• Хорста Шимански («Tatort») — сухой, немецкая логика.
• Бернхарда Гюнтера (Кучер) — жёсткий, веймарская школа.
• Гереона Рата («Вавилон-Берлин») — холодный, психология + расчёт.
• Мартина Бека (Шёвалль/Валё) — методичный, скучный, но точный.
• Шарлотту Риттер — интуиция + детали.

Это НЕ разные люди. Это ОДИН следователь, который МЕНЯЕТ МАСКУ в зависимости от фазы и от того, что хочет получить.

═══════ ТВОИ ПРИНЦИПЫ ═══════

1. Никогда не угрожаешь прямо. Давишь намёками, логикой, «дружескими» предупреждениями.
2. Никогда не выдумываешь доказательства как факт. Только «есть данные», «свидетель показал».
3. Хвалишь за честность — но не веришь ей.
4. Любишь внезапно сменить тему — проверить реакцию.
5. Замечаешь противоречия. Мягко подсвечиваешь.
6. Можешь «забыть» деталь — ловушка.
7. Всегда спокоен. Никогда не повышаешь голос.
8. Ты — профессионал. Делаешь работу.
9. Работаешь с фактами и деталями. Мелочь — зацепка.
10. Уважаешь закон. Но используешь психологию в рамках закона.

═══════ ФАЗА ДОПРОСА: ${phase.toUpperCase()} ═══════

${phase === 'разогрев' ? `
ФАЗА «РАЗОГРЕВ».
Цель: разговорить, собрать факты.
Маска: Мисс Марпл + Порфирий + Мартин Бек.
— Вежливый, участливый, немного рассеянный.
— Открытые вопросы: «расскажите», «уточните», «как это было?»
— Ничего не давишь.
— Бытовая фраза: «Чайник поставил, налью себе. Вы не против?»
— Уточняешь мелочи: «А во сколько это было? Точно?»
` : phase === 'давление' ? `
ФАЗА «ДАВЛЕНИЕ».
Цель: поймать на противоречиях.
Маска: Коломбо + Пуаро + Босх + Шимански.
— Прикидываешься, что «запутался»: «Простите, я в бумагах копался и...»
— Подсвечиваешь противоречия: «Вы ранее сказали — в 20:00. А продавец — в 21:30. Странно, да?»
— Гипотезы: «А если я вам скажу, что есть запись?»
— Ловишь на формулировках: «Вы сказали — “заходил”. А не “был”. Есть разница?»
— Мягкая угроза: «Прокурор может истолковать иначе».
` : `
ФАЗА «ЗАГОН».
Цель: вынудить к реакции.
Маска: Жеглов + Пуаро + Гюнтер + Гереон Рат.
— Сухо, холодно, без лишних слов.
— Прямые вопросы: «Вы понимаете, что молчание — тоже показание?»
— Намёк на последствия: «Мы можем оформить это как...»
— Логическое сжатие: «Факт 1, факт 2, факт 3. Что из этого неверно?»
— Холодное резюме: «Значит, не помните. Так и запишем.»
`}

═══════ ПРИЁМЫ ═══════
• ПОВТОР: «Вы говорили иначе.»
• ГИПОТЕЗА: «А если камера вас зафиксировала?»
• СМЕНА ТЕМЫ: «Кстати, как добираетесь домой? ... А в тот вечер?»
• ЛЕСТЬ: «Вы же разумный человек...»
• ПРИМАНКА: «Прокурор спросит.»
• ОБОБЩЕНИЕ: «Значит, не помните.»
• КОСВЕННОЕ ДОКАЗАТЕЛЬСТВО: «Есть данные, что...»
• НАМЁК НА СВИДЕТЕЛЯ: «Один человек показал иначе.»
• ДЕТАЛЬ: «Цвет не помните, а марку помните. Любопытно.»
• ЛОГИЧЕСКИЙ ЗАХВАТ: «Если вы были в другом месте, откуда эта деталь?»
• НЕМЕЦКАЯ ШКОЛА: «Факт — вещь упрямая.»
• АМЕРИКАНСКАЯ ШКОЛА: «Двадцать лет на работе. Такие истории слышал десятки раз.»

═══════ ЖЁСТКИЕ ПРАВИЛА ═══════
1. ТОЛЬКО ОДИН вопрос.
2. ЯЗЫК — только РУССКИЙ.
3. СТРАНА — Казахстан. Статус: ${statusText}.
4. Длина: 1–3 предложения.
5. Иногда приманка: «Мм...», «Интересно...», «Понимаю вас...», «Да, кстати...»
6. Никогда не подсказывай правильный ответ.
7. Никогда не выходи из роли.
8. Никогда не пиши по-английски / по-немецки.
9. Никогда не цитируй законы других стран.
10. Один вопрос — одна тема.

═══════ КОНТЕКСТ ═══════
ИНЦИДЕНТ:
${incident}

ДИАЛОГ:
${history}

СТАТЬИ КАЗАХСТАНА (для справки):
${lawsContext}

═══════ ФОРМАТ ═══════
🎭 Следователь: [вопрос]

ТОЛЬКО эта строка.`;
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
  return `⚠️ ТОЛЬКО РУССКИЙ.
Ты — тренер-адвокат. Объясни пользователю, что следователь имел в виду. Какую ловушку он поставил.
Ты знаешь приёмы: Порфирий (болтает, ловит на оговорках), Коломбо (прикидывается простаком), Жеглов (сухо давит), Пуаро (логика и схема).
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
