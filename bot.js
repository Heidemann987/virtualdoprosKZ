// bot.js — Dopros Trainer KZ v7 (UX: reply-меню, inline-кнопки, прогресс, резюме)
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
    console.error(`Failed to load laws_KZ.json:`, e.message);
    return [];
  }
}

const LAWS_KZ = loadLaws();
console.log(`📚 Laws loaded: KZ: ${LAWS_KZ.length}`);

// ============ MINI-RAG ============
function findRelevantArticles(query, limit = 5) {
  if (!LAWS_KZ.length) return [];
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.replace(/[^\w\sа-яё]/gi, ' ').split(/\s+/).filter(w => w.length > 3);

  const scored = LAWS_KZ.map(art => {
    let score = 0;
    for (const kw of art.keywords) {
      const kwLower = kw.toLowerCase();
      if (queryLower.includes(kwLower)) score += 3;
      for (const qw of queryWords) {
        if (kwLower.includes(qw) || qw.includes(kwLower)) score += 1;
      }
    }
    return { art, score };
  });

  return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.art);
}

// ============ STATUS ============
const STATUS = {
  witness: 'Свидетель',
  suspect: 'Подозреваемый',
  accused: 'Обвиняемый',
  victim: 'Потерпевший',
  plaintiff: 'Истец',
  defendant: 'Ответчик'
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

// ============ BUILD LAWS CONTEXT ============
function buildLawsContext(articles) {
  if (!articles.length) return '(нет найденных статей)';
  return articles.map(a => `\n### ${a.title}\n${a.text}\n`).join('\n');
}

// ============ PROGRESS BAR ============
function progressBar(sess) {
  const total = sess.correct + sess.warnings + sess.errors;
  return `📊 *Раунд ${sess.round}*  ·  ✅ ${sess.correct}  ⚠️ ${sess.warnings}  ❌ ${sess.errors}`;
}

// ============ QUESTION PROMPT ============
function buildQuestionPrompt(status, incident, history, relevantLaws) {
  const statusText = STATUS[status];
  const lawsContext = buildLawsContext(relevantLaws);
  return `⚠️ СТРОГО: только РУССКИЙ. ⚠️ СТРОГО: только законы КАЗАХСТАНА.
⚠️ ЗАПРЕЩЕНО: цитировать УК РФ, УПК РФ, Конституцию РФ, StPO, Grundgesetz.
⚠️ ОДИН вопрос. БЕЗ анализа. БЕЗ комментариев.

Страна: Казахстан. Статус: ${statusText}.

ИНЦИДЕНТ:
${incident}

ДИАЛОГ:
${history}

СТАТЬИ КАЗАХСТАНА:
${lawsContext}

ФОРМАТ:
🎭 Следователь: [один вопрос на русском]

ТОЛЬКО ЭТА СТРОКА.`;
}

// ============ EVALUATION PROMPT ============
function buildEvaluationPrompt(status, incident, history, relevantLaws) {
  const statusText = STATUS[status];
  const lawsContext = buildLawsContext(relevantLaws);
  return `⚠️ СТРОГО: только РУССКИЙ. ⚠️ СТРОГО: только законы КАЗАХСТАНА.
⚠️ ЗАПРЕЩЕНО: статьи РФ, Германии, английский язык.
⚠️ ТОЛЬКО формат ниже.

Страна: Казахстан. Статус: ${statusText}.

ИНЦИДЕНТ:
${incident}

ДИАЛОГ:
${history}

СТАТЬИ КАЗАХСТАНА:
${lawsContext}

ФОРМАТ (строго):

📊 Оценка: [✅ / ⚠️ / ❌]

⚠️ Ошибка: [1 предложение или "нет"]

🎯 Эталон: «[правильная формулировка]»

📚 Статьи: [точные названия из КАЗАХСТАН]

💬 Коротко: [1-2 предложения]

ТОЛЬКО ЭТОТ ФОРМАТ.`;
}

// ============ HINT PROMPT ============
function buildHintPrompt(status, incident, history, relevantLaws) {
  const statusText = STATUS[status];
  const lawsContext = buildLawsContext(relevantLaws);
  return `⚠️ ТОЛЬКО РУССКИЙ. ⚠️ ТОЛЬКО законы КАЗАХСТАНА. Максимум 2 предложения. НЕ давай полный ответ.

Страна: Казахстан. Статус: ${statusText}.
ИНЦИДЕНТ: ${incident}
ДИАЛОГ: ${history}

СТАТЬИ:
${lawsContext}

ФОРМАТ:
💡 Подсказка: [максимум 2 предложения]`;
}

// ============ SUMMARY PROMPT ============
function buildSummaryPrompt(status, incident, history, relevantLaws, stats) {
  const statusText = STATUS[status];
  const lawsContext = buildLawsContext(relevantLaws);
  return `⚠️ ТОЛЬКО РУССКИЙ. ⚠️ ТОЛЬКО законы КАЗАХСТАНА. Без английского.

Проанализируй тренировку и дай резюме.

Статус: ${statusText}.
Статистика: правильных ${stats.correct}, замечаний ${stats.warnings}, ошибок ${stats.errors}.

ИНЦИДЕНТ:
${incident}

ДИАЛОГ:
${history}

СТАТЬИ КАЗАХСТАНА:
${lawsContext}

ФОРМАТ (строго):

🎓 ИТОГ ТРЕНИРОВКИ

✅ Правильных ответов: ${stats.correct}
⚠️ С замечаниями: ${stats.warnings}
❌ Ошибок: ${stats.errors}

📊 Слабые места:
• [пункт 1]
• [пункт 2]
• [пункт 3]

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
    .text('🎓 Завершить тренировку').text('💡 Подсказка').row()
    .text('📊 Итог').text('🔄 Сменить статус').row()
    .resized().persistent();
}

function questionInlineKeyboard() {
  return new InlineKeyboard()
    .text('💡 Подсказка', 'hint').row()
    .text('📚 Статьи', 'show_laws').row()
    .text('⏭️ Пропустить', 'skip_question');
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
      console.log(`⚠️ Rate limit (${attempt}/3). Retry in ${wait}s...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      return callAI(prompt, maxTokens, attempt + 1);
    }
    throw e;
  }

  const langWrong = detectLanguage(text) === 'latin';
  const jurWrong = hasWrongJurisdiction(text);
  if (langWrong || jurWrong) {
    console.warn(`⚠️ Guard triggered. Retrying...`);
    try {
      const retry = await ai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: text },
          { role: 'user', content: `НЕВЕРНО! Только на РУССКОМ. Только законы КАЗАХСТАНА. Только формат.` }
        ],
        temperature: 0.2,
        max_tokens: maxTokens
      });
      const retryText = retry.choices[0].message.content || '';
      if (!hasWrongJurisdiction(retryText)) text = retryText;
    } catch (e) {
      console.warn('Retry failed:', e.message);
    }
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
    round: 0, correct: 0, warnings: 0, errors: 0,
    currentQuestion: null, lastLaws: []
  });
  await ctx.answerCallbackQuery();

  const kb = new InlineKeyboard()
    .text('👤 Свидетель', 'st:witness').row()
    .text('🚨 Подозреваемый', 'st:suspect').row()
    .text('⚖️ Обвиняемый', 'st:accused').row()
    .text('🛡️ Потерпевший', 'st:victim').row()
    .text('📋 Истец', 'st:plaintiff').row()
    .text('📋 Ответчик', 'st:defendant');

  await ctx.reply('*Выберите свой процессуальный статус:*', { parse_mode: 'Markdown', reply_markup: kb });
});

// ============ STATUS ============
bot.callbackQuery(/^st:(witness|suspect|accused|victim|plaintiff|defendant)$/, async (ctx) => {
  const status = ctx.match[1];
  const sess = sessions.get(ctx.from.id);
  if (!sess) return ctx.answerCallbackQuery({ text: 'Начните с /start' });
  sess.status = status;
  await ctx.answerCallbackQuery();
  const statusText = STATUS[status];
  await ctx.reply(
    `*${statusText}*\n\n*Опишите подробно свой инцидент:*\n\n• Что произошло?\n• Когда?\n• Кто участвовал?\n• Что делали вы?\n\n⚠️ Без личных данных.`,
    { parse_mode: 'Markdown' }
  );
});

// ============ /reset ============
bot.command('reset', async (ctx) => {
  sessions.delete(ctx.from.id);
  await ctx.reply('Сброшено. Напишите /start.');
});

// ============ /help ============
bot.command('help', async (ctx) => {
  await ctx.reply(
    '⚖️ *Тренажёр допроса (Казахстан)*\n\n' +
    '• /start — начать\n• /reset — сбросить\n• /finish — итог\n• /help — справка\n\n' +
    '📚 Статьи: УК РК, УПК РК, Конституция РК.',
    { parse_mode: 'Markdown' }
  );
});

// ============ Reply keyboard: Завершить ============
bot.hears('🎓 Завершить тренировку', async (ctx) => {
  await handleFinish(ctx);
});

// ============ Reply keyboard: Подсказка ============
bot.hears('💡 Подсказка', async (ctx) => {
  await handleHint(ctx);
});

// ============ Reply keyboard: Итог ============
bot.hears('📊 Итог', async (ctx) => {
  await handleFinish(ctx);
});

// ============ Reply keyboard: Сменить статус ============
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

// ============ INLINE: Подсказка ============
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
    const lastQ = sess.history.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
    const relevant = findRelevantArticles(sess.incident + ' ' + lastQ, 3);
    const histText = sess.history.map(m => (m.role === 'user' ? '👤 ' : '🎭 ') + m.content).join('\n\n');
    const answer = await callAI(buildHintPrompt(sess.status, sess.incident, histText, relevant), 300);
    await ctx.reply(answer, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(e);
    await ctx.reply('⚠️ Ошибка подсказки. Попробуйте ещё раз.');
  }
}

// ============ INLINE: Показать статьи ============
bot.callbackQuery('show_laws', async (ctx) => {
  await ctx.answerCallbackQuery();
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.lastLaws || !sess.lastLaws.length) {
    return ctx.reply('📚 Статьи пока не подобраны. Начните тренировку.');
  }
  let text = '📚 *Релевантные статьи:*\n\n';
  for (const a of sess.lastLaws) {
    text += `*${a.title}*\n${a.text}\n\n`;
  }
  await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ============ INLINE: Пропустить ============
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
bot.command('finish', async (ctx) => {
  await handleFinish(ctx);
});

async function handleFinish(ctx) {
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.incident) return ctx.reply('Нет активной сессии.');

  await ctx.replyWithChatAction('typing');
  try {
    const allText = sess.incident + ' ' + sess.history.map(m => m.content).join(' ');
    const relevant = findRelevantArticles(allText, 5);
    const summary = await callAI(
      buildSummaryPrompt(sess.status, sess.incident, sess.history.map(m => m.content).join('\n\n'), relevant, sess),
      1200
    );
    await ctx.reply(summary, { parse_mode: 'Markdown' });
    await ctx.reply('Напишите /start для новой тренировки.');
    sessions.delete(ctx.from.id);
  } catch (e) {
    console.error(e);
    await ctx.reply('⚠️ Ошибка формирования итога. Попробуйте /finish ещё раз.');
  }
}

// ============ NEXT QUESTION ============
async function nextQuestion(ctx, sess) {
  await ctx.replyWithChatAction('typing');
  try {
    const histText = sess.history.map(m => (m.role === 'user' ? '👤 ' : '🎭 ') + m.content).join('\n\n');
    const allText = sess.incident + ' ' + histText;
    const relevant = findRelevantArticles(allText, 5);
    sess.lastLaws = relevant;

    const question = await callAI(
      buildQuestionPrompt(sess.status, sess.incident, histText, relevant),
      500
    );
    sess.currentQuestion = question;
    sess.history.push({ role: 'assistant', content: question });

    // Прогресс + вопрос отдельными сообщениями
    await ctx.reply(progressBar(sess), { parse_mode: 'Markdown' });
    await ctx.reply(question, { parse_mode: 'Markdown', reply_markup: questionInlineKeyboard() });
  } catch (e) {
    console.error('AI error:', e);
    await ctx.reply('⚠️ ИИ временно недоступен. Отправьте сообщение через 30 секунд.');
  }
}

// ============ MAIN ============
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;
  if (['🎓 Завершить тренировку', '💡 Подсказка', '📊 Итог', '🔄 Сменить статус'].includes(text)) return;

  const userId = ctx.from.id;
  const sess = sessions.get(userId);
  if (!sess) return ctx.reply('Начните с /start');
  if (!sess.mode) return ctx.reply('Выберите режим: /start');
  if (!sess.status) return ctx.reply('Выберите статус: /start');

  // ========== ПЕРВЫЙ ИНЦИДЕНТ ==========
  if (!sess.incident) {
    sess.incident = text;
    sess.history = [{ role: 'user', content: 'Инцидент: ' + text }];
    sess.round = 1;

    await ctx.reply('⏳ Готовлю первый вопрос...');

    const relevant = findRelevantArticles(text, 5);
    sess.lastLaws = relevant;
    console.log(`🔍 RAG: найдено ${relevant.length} статей`);

    try {
      await ctx.replyWithChatAction('typing');
      const question = await callAI(
        buildQuestionPrompt(sess.status, sess.incident, 'Инцидент: ' + text, relevant),
        500
      );
      sess.currentQuestion = question;
      sess.history.push({ role: 'assistant', content: question });

      // Reply-меню показываем
      await ctx.reply(
        '⚖️ *Тренажёр запущен.*\n\nКнопки внизу — быстрые действия.',
        { parse_mode: 'Markdown', reply_markup: mainReplyKeyboard() }
      );

      await ctx.reply(progressBar(sess), { parse_mode: 'Markdown' });
      await ctx.reply(question, { parse_mode: 'Markdown', reply_markup: questionInlineKeyboard() });
    } catch (e) {
      console.error('AI error:', e);
      await ctx.reply('⚠️ Ошибка ИИ. Попробуйте /start заново.');
    }
    return;
  }

  // ========== ОТВЕТ ПОЛЬЗОВАТЕЛЯ ==========
  sess.history.push({ role: 'user', content: text });
  await ctx.reply('⏳ Анализирую ответ...');

  const lastQ = sess.currentQuestion || '';
  const relevant = findRelevantArticles(lastQ + ' ' + text, 5);
  sess.lastLaws = relevant;
  console.log(`🔍 RAG: найдено ${relevant.length} статей для оценки`);

  try {
    await ctx.replyWithChatAction('typing');
    const histText = sess.history.map(m => (m.role === 'user' ? '👤 ' : '🎭 ') + m.content).join('\n\n');
    const evaluation = await callAI(
      buildEvaluationPrompt(sess.status, sess.incident, histText, relevant),
      700
    );

    // Считаем статистику
    if (evaluation.includes('📊 Оценка: ✅')) sess.correct++;
    else if (evaluation.includes('📊 Оценка: ⚠️')) sess.warnings++;
    else if (evaluation.includes('📊 Оценка: ❌')) sess.errors++;
    sess.round++;

    // ОТДЕЛЬНОЕ сообщение с оценкой
    await ctx.reply(evaluation, { parse_mode: 'Markdown' });

    // ОТДЕЛЬНОЕ сообщение со следующим вопросом
    await nextQuestion(ctx, sess);

  } catch (e) {
    console.error('AI error:', e);
    await ctx.reply('⚠️ ИИ временно недоступен. Отправьте сообщение через 30 секунд.');
  }
});

// ============ FINISH ACTION (старый callback) ============
bot.callbackQuery('finish_action', async (ctx) => {
  await ctx.answerCallbackQuery();
  await handleFinish(ctx);
});

// ============ ЗАПУСК С RETRY ============
let retryCount = 0;
const MAX_RETRIES = 10;

async function startBot() {
  try {
    await bot.start({
      drop_pending_updates: true,
      onStart: (botInfo) => {
        console.log(`🚀 Dopros Trainer KZ v7 started as @${botInfo.username}`);
        retryCount = 0;
      }
    });
  } catch (e) {
    const is409 = e.message && e.message.includes('409');
    if (is409 && retryCount < MAX_RETRIES) {
      retryCount++;
      const wait = Math.min(30 * retryCount, 120);
      console.log(`⚠️ 409 (attempt ${retryCount}/${MAX_RETRIES}). Retry in ${wait}s...`);
      setTimeout(startBot, wait * 1000);
    } else {
      console.error('❌ Fatal:', e.message);
      process.exit(1);
    }
  }
}
startBot();

const httpApp = express();
httpApp.get('/', (req, res) => res.send('Dopros Trainer KZ v7 running'));
const PORT = process.env.PORT || 3000;
httpApp.listen(PORT, () => console.log('HTTP server on port ' + PORT));
