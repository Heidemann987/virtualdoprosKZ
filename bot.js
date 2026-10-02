// bot.js — Dopros Trainer KZ v8 (права, жалобы, обучение, сравнение)
const { Bot, InlineKeyboard, Keyboard } = require('grammy');
const OpenAI = require('openai');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ============ CONFIG ============
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';

if (!BOT_TOKEN) { console.error('TELEGRAM_BOT_TOKEN missing'); process.exit(1); }
if (!OPENROUTER_KEY) { console.error('OPENROUTER_API_KEY missing'); process.exit(1); }

const ai = new OpenAI({
  apiKey: OPENROUTER_KEY,
  baseURL: 'https://openrouter.ai/api/v1'
});

// ============ LOAD LAWS ============
function loadLaws() {
  try {
    const filePath = path.join(__dirname, 'laws_KZ.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return data.articles || [];
  } catch (e) {
    console.error('laws_KZ.json:', e.message);
    return [];
  }
}
const LAWS_KZ = loadLaws();
console.log(`📚 Laws loaded: KZ: ${LAWS_KZ.length}`);

// ============ MINI-RAG ============
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

// ============ STATUS ============
const STATUS = {
  witness: 'Свидетель', suspect: 'Подозреваемый', accused: 'Обвиняемый',
  victim: 'Потерпевший', plaintiff: 'Истец', defendant: 'Ответчик'
};

// ============ SCENARIOS ============
const SCENARIOS = {
  theft: {
    emoji: '🏪', title: 'Кража в магазине',
    text: 'Меня вызвали на допрос как свидетеля по делу о краже в магазине. В магазине пропал телефон. Следователь утверждает, что камеры показали моего брата рядом с витриной. Он спрашивает, что мне известно о брате и о краже.'
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
function buildQuestionPrompt(status, incident, history, relevantLaws) {
  return `⚠️ СТРОГО: только РУССКИЙ. ⚠️ ТОЛЬКО законы КАЗАХСТАНА.
⚠️ ЗАПРЕЩЕНО: статьи РФ, Германии, английский.
⚠️ ОДИН вопрос. БЕЗ анализа.

Страна: Казахстан. Статус: ${STATUS[status]}.

ИНЦИДЕНТ:
${incident}

ДИАЛОГ:
${history}

СТАТЬИ:
${buildLawsContext(relevantLaws)}

ФОРМАТ:
🎭 Следователь: [один вопрос на русском]`;
}

function buildEvaluationPrompt(status, incident, history, relevantLaws) {
  return `⚠️ СТРОГО: только РУССКИЙ. ⚠️ ТОЛЬКО законы КАЗАХСТАНА.
⚠️ ТОЛЬКО формат ниже.

Страна: Казахстан. Статус: ${STATUS[status]}.

ИНЦИДЕНТ:
${incident}

ДИАЛОГ:
${history}

СТАТЬИ:
${buildLawsContext(relevantLaws)}

ФОРМАТ (строго):

📊 Оценка: [✅ / ⚠️ / ❌]

⚠️ Ошибка: [1 предложение или "нет"]

🎯 Эталон: «[правильная формулировка]»

📚 Статьи: [названия из КАЗАХСТАН]

💬 Коротко: [1-2 предложения]

ТОЛЬКО ЭТОТ ФОРМАТ.`;
}

function buildHintPrompt(status, incident, history, relevantLaws) {
  return `⚠️ ТОЛЬКО РУССКИЙ. Максимум 2 предложения. НЕ давай полный ответ.

Страна: Казахстан. Статус: ${STATUS[status]}.
ИНЦИДЕНТ: ${incident}
ДИАЛОГ: ${history}

СТАТЬИ:
${buildLawsContext(relevantLaws)}

ФОРМАТ:
💡 Подсказка: [максимум 2 предложения]`;
}

function buildMeaningPrompt(question, incident, relevantLaws) {
  return `⚠️ ТОЛЬКО РУССКИЙ. Объясни, что следователь на самом деле имел в виду. Какая ловушка?

ВОПРОС СЛЕДОВАТЕЛЯ: "${question}"
ИНЦИДЕНТ: ${incident}

СТАТЬИ:
${buildLawsContext(relevantLaws)}

ФОРМАТ:
🤔 Что имел в виду следователь:
• 🎯 Цель вопроса: [1 предложение]
• ⚠️ Опасность: [1 предложение]
• 🛡️ Как отвечать: [1-2 предложения]

ТОЛЬКО ЭТОТ ФОРМАТ.`;
}

function buildActionPrompt(action, status, incident, question) {
  const actions = {
    silence: 'право на молчание (ст. 77 п. 7 Конституции РК)',
    lawyer: 'право на защитника (ст. 64, 65-1 УПК РК)',
    break: 'право на перерыв (ст. 210 УПК РК — не более 4 часов без перерыва)',
    note: 'право на внесение замечаний в протокол (ст. 64 УПК РК)',
    pressure: 'право жаловаться на давление (ст. 64 УПК РК)',
    translator: 'право на бесплатного переводчика (ст. 64 УПК РК)',
    refuse_sign: 'право отказаться от подписи при искажениях',
    clarify: 'право потребовать уточнения вопроса'
  };
  return `⚠️ ТОЛЬКО РУССКИЙ. Дай пользователю точную формулировку для ситуации.

Ситуация: пользователь хочет использовать ${actions[action]}.
Статус: ${STATUS[status]}.
Текущий вопрос следователя: "${question || '(нет)'}"
ИНЦИДЕНТ: ${incident}

ФОРМАТ:
🛡️ *${actions[action]}*

📝 Формулировка:
«[точная фраза, которую надо сказать]»

⚖️ Основание: [статья]

💡 Совет: [1 предложение]

ТОЛЬКО ЭТОТ ФОРМАТ.`;
}

function buildComplaintPrompt(type, status, incident) {
  const types = {
    prosecutor: 'жалоба прокурору',
    higher: 'жалоба в вышестоящий орган',
    protocol: 'требование внести в протокол',
    document: 'фиксация нарушения (аудио/видео/свидетели)'
  };
  return `⚠️ ТОЛЬКО РУССКИЙ. Дай пользователю инструкцию по действию: ${types[type]}.

Статус: ${STATUS[status]}.
ИНЦИДЕНТ: ${incident}

ФОРМАТ:
📞 *${types[type]}*

📝 Куда/что:
[1-2 предложения]

🎯 Как:
1. [шаг 1]
2. [шаг 2]
3. [шаг 3]

⚖️ Основание: [статья]

ТОЛЬКО ЭТОТ ФОРМАТ.`;
}

function buildSummaryPrompt(status, incident, history, relevantLaws, stats) {
  return `⚠️ ТОЛЬКО РУССКИЙ. ⚠️ ТОЛЬКО законы КАЗАХСТАНА.

Проанализируй тренировку.

Статус: ${STATUS[status]}.
Статистика: ✅ ${stats.correct}, ⚠️ ${stats.warnings}, ❌ ${stats.errors}.
Действий использовано: ${stats.actionsUsed || 0}.

ИНЦИДЕНТ:
${incident}

ДИАЛОГ:
${history}

СТАТЬИ:
${buildLawsContext(relevantLaws)}

ФОРМАТ:

🎓 ИТОГ ТРЕНИРОВКИ

✅ Правильных: ${stats.correct}
⚠️ С замечаниями: ${stats.warnings}
❌ Ошибок: ${stats.errors}

📊 Слабые места:
• [пункт 1]
• [пункт 2]

💡 Что повторить:
• [статья 1]
• [статья 2]

🎯 Рекомендация: [1-2 предложения]

ТОЛЬКО ЭТОТ ФОРМАТ.`;
}

// ============ SESSIONS ============
const sessions = new Map();

// ============ KEYBOARDS ============
function mainReplyKeyboard() {
  return new Keyboard()
    .text('🎓 Завершить').text('💡 Подсказка').row()
    .text('🛡️ Мои права').text('📊 Итог').row()
    .text('🔄 Сменить статус').resized().persistent();
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

// ============ PROGRESS ============
function progressBar(sess) {
  return `📊 *Раунд ${sess.round}*  ·  ✅ ${sess.correct}  ⚠️ ${sess.warnings}  ❌ ${sess.errors}`;
}

// ============ BOT ============
const bot = new Bot(BOT_TOKEN);
bot.catch((err) => console.error('Bot error:', err));

// ============ AI CALL ============
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
    const is429 = e.message && (e.message.includes('429') || e.message.includes('rate') || e.message.includes('quota'));
    if (is429 && attempt < 3) {
      const wait = attempt * 15;
      console.log(`⚠️ Rate limit. Retry in ${wait}s...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      return callAI(prompt, maxTokens, attempt + 1);
    }
    throw e;
  }
  const wrong = detectLanguage(text) === 'latin' || hasWrongJurisdiction(text);
  if (wrong) {
    console.warn('⚠️ Guard triggered. Retrying...');
    try {
      const retry = await ai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: text },
          { role: 'user', content: `НЕВЕРНО! Только РУССКИЙ. Только законы КАЗАХСТАНА. Только формат.` }
        ],
        temperature: 0.2, max_tokens: maxTokens
      });
      const rt = retry.choices[0].message.content || '';
      if (!hasWrongJurisdiction(rt)) text = rt;
    } catch (e) { console.warn('Retry failed:', e.message); }
  }
  return text;
}

// ============ /start ============
bot.command('start', async (ctx) => {
  sessions.delete(ctx.from.id);
  const kb = new InlineKeyboard()
    .text('🎓 Новичок', 'mode:beginner').row()
    .text('📝 Экзамен', 'mode:exam');
  await ctx.reply(
    '⚖️ *Тренажёр допроса (Казахстан)*\n\n' +
    '⚠️ Это тренажёр, не замена адвоката.\n\n' +
    'Выберите режим:',
    { parse_mode: 'Markdown', reply_markup: kb }
  );
});

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

  await ctx.reply(
    `*${STATUS[status]}*\n\n*Выберите сценарий* или опишите свой инцидент:`,
    { parse_mode: 'Markdown', reply_markup: kb }
  );
});

// ============ SCENARIO ============
bot.callbackQuery(/^sc:(theft|accident|fraud|burglary|witness_other|custom)$/, async (ctx) => {
  const key = ctx.match[1];
  const sess = sessions.get(ctx.from.id);
  if (!sess) return ctx.answerCallbackQuery({ text: 'Начните с /start' });
  await ctx.answerCallbackQuery();

  if (key === 'custom') {
    await ctx.reply(
      `*${STATUS[sess.status]}*\n\n*Опишите свой инцидент:*\n\n• Что произошло?\n• Когда?\n• Кто участвовал?\n• Что делали вы?\n\n⚠️ Без личных данных.`
    );
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

  const relevant = findRelevantArticles(incidentText, 5);
  sess.lastLaws = relevant;
  console.log(`🔍 RAG: ${relevant.length} статей`);

  try {
    await ctx.replyWithChatAction('typing');
    const question = await callAI(
      buildQuestionPrompt(sess.status, sess.incident, 'Инцидент: ' + incidentText, relevant),
      500
    );
    sess.currentQuestion = question;
    sess.history.push({ role: 'assistant', content: question });

    await ctx.reply('⚖️ *Тренажёр запущен.*\n\nКнопки внизу — быстрые действия.', {
      parse_mode: 'Markdown', reply_markup: mainReplyKeyboard()
    });
    await ctx.reply(progressBar(sess), { parse_mode: 'Markdown' });
    await ctx.reply(question, { parse_mode: 'Markdown', reply_markup: questionInlineKeyboard() });
  } catch (e) {
    console.error('AI error:', e);
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
  await ctx.reply('🛡️ *Выберите процессуальное действие:*', {
    parse_mode: 'Markdown', reply_markup: rightsInlineKeyboard()
  });
});
bot.hears('🔄 Сменить статус', async (ctx) => {
  const sess = sessions.get(ctx.from.id);
  if (!sess) return ctx.reply('Начните с /start');
  const kb = new InlineKeyboard()
    .text('👤 Свидетель', 'st:witness').row()
    .text('🚨 Подозреваемый', 'st:suspect').row()
    .text('⚖️ Обвиняемый', 'st:accused').row()
    .text('🛡️ Потерпевший', 'st:victim').row()
    .text('📋 Истец', 'st:plaintiff').row()
    .text('📋 Ответчик', 'st:defendant');
  await ctx.reply('*Выберите новый статус:*', { parse_mode: 'Markdown', reply_markup: kb });
});

// ============ INLINE: Hint ============
bot.callbackQuery('hint', async (ctx) => {
  await ctx.answerCallbackQuery();
  await handleHint(ctx);
});
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
  } catch (e) {
    console.error(e);
    await ctx.reply('⚠️ Ошибка подсказки.');
  }
}

// ============ INLINE: Meaning ============
bot.callbackQuery('meaning', async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.currentQuestion) return ctx.reply('Начните с /start');

  await ctx.replyWithChatAction('typing');
  try {
    const relevant = findRelevantArticles(sess.currentQuestion, 3);
    const answer = await callAI(
      buildMeaningPrompt(sess.currentQuestion, sess.incident, relevant),
      500
    );
    await ctx.reply(answer, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(e);
    await ctx.reply('⚠️ Ошибка разбора.');
  }
});

// ============ RIGHTS MENU ============
bot.callbackQuery('rights_menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.incident) return ctx.reply('Начните с /start');
  await ctx.reply('🛡️ *Выберите процессуальное действие:*', {
    parse_mode: 'Markdown', reply_markup: rightsInlineKeyboard()
  });
});

// ============ ACTION ============
bot.callbackQuery(/^act:(silence|lawyer|break|note|pressure|translator|refuse_sign|clarify)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const action = ctx.match[1];
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.incident) return ctx.reply('Начните с /start');

  sess.actionsUsed = (sess.actionsUsed || 0) + 1;

  await ctx.replyWithChatAction('typing');
  try {
    const answer = await callAI(
      buildActionPrompt(action, sess.status, sess.incident, sess.currentQuestion),
      500
    );
    await ctx.reply(answer, { parse_mode: 'Markdown' });
    await ctx.reply('Продолжаем тренировку. Ответьте на вопрос следователя или используйте другое право.');
  } catch (e) {
    console.error(e);
    await ctx.reply('⚠️ Ошибка. Попробуйте ещё раз.');
  }
});

// ============ COMPLAINTS MENU ============
bot.callbackQuery('complaint_menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.incident) return ctx.reply('Начните с /start');
  await ctx.reply('📞 *Жалобы и фиксация нарушений:*', {
    parse_mode: 'Markdown', reply_markup: complaintsInlineKeyboard()
  });
});

// ============ COMPLAINT ACTION ============
bot.callbackQuery(/^comp:(prosecutor|higher|protocol|document)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const type = ctx.match[1];
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.incident) return ctx.reply('Начните с /start');

  await ctx.replyWithChatAction('typing');
  try {
    const answer = await callAI(buildComplaintPrompt(type, sess.status, sess.incident), 500);
    await ctx.reply(answer, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(e);
    await ctx.reply('⚠️ Ошибка. Попробуйте ещё раз.');
  }
});

// ============ SHOW LAWS ============
bot.callbackQuery('show_laws', async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.lastLaws || !sess.lastLaws.length) {
    return ctx.reply('📚 Статьи пока не подобраны.');
  }
  let text = '📚 *Релевантные статьи:*\n\n';
  for (const a of sess.lastLaws) text += `*${a.title}*\n${a.text}\n\n`;
  await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ============ COMPARE WITH STANDARD ============
bot.callbackQuery('compare_with_standard', async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.lastEvaluation || !sess.lastUserAnswer) {
    return ctx.reply('📊 Пока нечего сравнивать. Ответьте на вопрос следователя.');
  }
  const match = sess.lastEvaluation.match(/🎯 Эталон: «(.+?)»/s);
  const standard = match ? match[1] : '(не найдено)';
  const text =
    `📊 *Сравнение с эталоном*\n\n` +
    `👤 *Ваш ответ:*\n«${sess.lastUserAnswer}»\n\n` +
    `🎯 *Эталон:*\n«${standard}»\n\n` +
    `💡 Обратите внимание на:\n• Точность формулировки\n• Ссылку на статью\n• Краткость и чёткость\n\n` +
    `Попробуйте при следующем ответе использовать структуру эталона.`;
  await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ============ SKIP ============
bot.callbackQuery('skip_question', async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.incident) return ctx.reply('Начните с /start');
  sess.round++;
  sess.errors++;
  sess.history.push({ role: 'user', content: '[Пропущен вопрос]' });
  await nextQuestion(ctx, sess);
});

// ============ /finish ============
bot.command('finish', async (ctx) => { await handleFinish(ctx); });
async function handleFinish(ctx) {
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.incident) return ctx.reply('Нет активной сессии.');

  await ctx.replyWithChatAction('typing');
  try {
    const hist = sess.history.map(m => (m.role === 'user' ? '👤 ' : '🎭 ') + m.content).join('\n\n');
    const allText = sess.incident + ' ' + hist;
    const relevant = findRelevantArticles(allText, 5);
    const summary = await callAI(buildSummaryPrompt(sess.status, sess.incident, hist, relevant, sess), 1200);
    await ctx.reply(summary, { parse_mode: 'Markdown' });
    await ctx.reply('Напишите /start для новой тренировки.');
    sessions.delete(ctx.from.id);
  } catch (e) {
    console.error(e);
    await ctx.reply('⚠️ Ошибка формирования итога.');
  }
}

// ============ NEXT QUESTION ============
async function nextQuestion(ctx, sess) {
  await ctx.replyWithChatAction('typing');
  try {
    const hist = sess.history.map(m => (m.role === 'user' ? '👤 ' : '🎭 ') + m.content).join('\n\n');
    const allText = sess.incident + ' ' + hist;
    const relevant = findRelevantArticles(allText, 5);
    sess.lastLaws = relevant;

    const question = await callAI(buildQuestionPrompt(sess.status, sess.incident, hist, relevant), 500);
    sess.currentQuestion = question;
    sess.history.push({ role: 'assistant', content: question });

    await ctx.reply(progressBar(sess), { parse_mode: 'Markdown' });
    await ctx.reply(question, { parse_mode: 'Markdown', reply_markup: questionInlineKeyboard() });
  } catch (e) {
    console.error(e);
    await ctx.reply('⚠️ ИИ временно недоступен. Подождите 30 секунд.');
  }
}

// ============ MAIN TEXT ============
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  const labels = ['🎓 Завершить', '💡 Подсказка', '📊 Итог', '🛡️ Мои права', '🔄 Сменить статус'];
  if (labels.includes(text)) return;

  const sess = sessions.get(ctx.from.id);
  if (!sess) return ctx.reply('Начните с /start');
  if (!sess.status) return ctx.reply('Выберите статус: /start');

  if (!sess.incident) {
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
    console.error('AI error:', e);
    await ctx.reply('⚠️ ИИ временно недоступен. Подождите 30 секунд.');
  }
});

// ============ START WITH RETRY ============
let retryCount = 0;
const MAX_RETRIES = 10;
async function startBot() {
  try {
    await bot.start({
      drop_pending_updates: true,
      onStart: (bi) => {
        console.log(`🚀 Dopros Trainer KZ v8 started as @${bi.username}`);
        retryCount = 0;
      }
    });
  } catch (e) {
    const is409 = e.message && e.message.includes('409');
    if (is409 && retryCount < MAX_RETRIES) {
      retryCount++;
      const wait = Math.min(30 * retryCount, 120);
      console.log(`⚠️ 409 (${retryCount}/${MAX_RETRIES}). Retry in ${wait}s...`);
      setTimeout(startBot, wait * 1000);
    } else {
      console.error('❌ Fatal:', e.message);
      process.exit(1);
    }
  }
}
startBot();

const httpApp = express();
httpApp.get('/', (req, res) => res.send('Dopros Trainer KZ v8 running'));
const PORT = process.env.PORT || 3000;
httpApp.listen(PORT, () => console.log('HTTP server on port ' + PORT));
