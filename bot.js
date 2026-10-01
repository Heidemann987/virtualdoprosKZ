// bot.js — Dopros Trainer KZ (мини-RAG + УК РК + УПК РК)
const { Bot, InlineKeyboard } = require('grammy');
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
  const queryWords = queryLower
    .replace(/[^\w\sа-яё]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3);

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

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.art);
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

// ============ LANGUAGE & JURISDICTION GUARD ============
function detectLanguage(text) {
  const latinCount = (text.match(/[a-zA-Z]/g) || []).length;
  const cyrillicCount = (text.match(/[а-яА-ЯёЁ]/g) || []).length;
  const total = latinCount + cyrillicCount;
  if (total === 0) return 'unknown';
  return latinCount > cyrillicCount ? 'latin' : 'cyrillic';
}

function hasWrongJurisdiction(text) {
  const textLower = text.toLowerCase();
  // Проверяем на упоминания статей других стран
  if (/конституц[а-я]+ рф|упк рф|ук рф|гпк рф|коап рф/.test(textLower)) return true;
  if (/stpo|stgb|grundgesetz|zpo|owig/.test(textLower)) return true;
  return false;
}

// ============ BUILD LAWS CONTEXT ============
function buildLawsContext(articles) {
  if (!articles.length) {
    return '(нет найденных статей из УК РК / УПК РК / Конституции РК)';
  }
  return articles.map(a => `\n### ${a.title}\n${a.text}\n`).join('\n');
}

// ============ QUESTION PROMPT ============
function buildQuestionPrompt(status, incident, history, relevantLaws) {
  const statusText = STATUS[status];
  const lawsContext = buildLawsContext(relevantLaws);

  return `⚠️ СТРОГО: отвечай ТОЛЬКО на РУССКОМ.
⚠️ СТРОГО: только законы КАЗАХСТАНА: УК РК / УПК РК / Конституция РК / КоАП РК.
⚠️ ЗАПРЕЩЕНО: цитировать Конституцию РФ, УК РФ, УПК РФ, StPO, Grundgesetz.
⚠️ ЗАПРЕЩЕНО: анализ, "The user...", показ рассуждений, выдумывание фактов.
⚠️ ТОЛЬКО ОДИН вопрос.

Страна: Казахстан
Статус: ${statusText}

ИНЦИДЕНТ:
${incident}

ДИАЛОГ:
${history}

СТАТЬИ КАЗАХСТАНА (ТОЛЬКО ЭТИ):
${lawsContext}

ФОРМАТ (строго):
🎭 Следователь: [один вопрос на русском]

ТВОЙ ОТВЕТ: ТОЛЬКО ЭТА СТРОКА ФОРМАТА.`;
}

// ============ COMBINED PROMPT (оценка + следующий вопрос) ============
function buildCombinedPrompt(status, incident, history, relevantLaws) {
  const statusText = STATUS[status];
  const lawsContext = buildLawsContext(relevantLaws);

  return `⚠️ СТРОГО: только РУССКИЙ. ⚠️ СТРОГО: только законы КАЗАХСТАНА.
⚠️ ЗАПРЕЩЕНО: цитировать УК РФ, УПК РФ, Конституцию РФ, StPO, Grundgesetz.
⚠️ ТОЛЬКО формат ниже. Никакого текста до/после.

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

---

🎭 Следователь: [СЛЕДУЮЩИЙ вопрос на русском]

ТОЛЬКО ЭТОТ ФОРМАТ.`;
}

// ============ HINT PROMPT ============
function buildHintPrompt(status, incident, history, relevantLaws) {
  const statusText = STATUS[status];
  const lawsContext = buildLawsContext(relevantLaws);

  return `⚠️ ТОЛЬКО РУССКИЙ. ⚠️ ТОЛЬКО законы КАЗАХСТАНА. Максимум 2 предложения.

Страна: Казахстан. Статус: ${statusText}.
ИНЦИДЕНТ: ${incident}
ДИАЛОГ: ${history}

СТАТЬИ:
${lawsContext}

ФОРМАТ:
💡 Подсказка: [максимум 2 предложения]`;
}

// ============ SESSIONS ============
const sessions = new Map();

// ============ BOT ============
const bot = new Bot(BOT_TOKEN);
bot.catch((err) => console.error('Bot error:', err));

// ============ AI CALL with retry (429 aware) ============
async function callAI(prompt, maxTokens, attempt = 1) {
  let text = '';
  try {
    const response = await ai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: maxTokens
    });
    text = response.choices[0].message.content || '';
  } catch (e) {
    const is429 = e.message && (e.message.includes('429') || e.message.includes('rate') || e.message.includes('quota') || e.message.includes('limit'));
    if (is429 && attempt < 3) {
      const wait = attempt * 15;
      console.log(`⚠️ Rate limit (${attempt}/3). Retry in ${wait}s...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      return callAI(prompt, maxTokens, attempt + 1);
    }
    console.error('AI request failed:', e.message);
    throw e;
  }

  const lang = detectLanguage(text);
  const langWrong = lang === 'latin';
  const jurWrong = hasWrongJurisdiction(text);

  // Guard-retry ТОЛЬКО один раз
  if (langWrong || jurWrong) {
    console.warn(`⚠️ Guard triggered: lang=${lang}, jurWrong=${jurWrong}. Retrying...`);
    try {
      const retryResponse = await ai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: text },
          {
            role: 'user',
            content: `НЕВЕРНО! Только на РУССКОМ. Только законы КАЗАХСТАНА. Никаких статей РФ/Германии. Только формат.`
          }
        ],
        temperature: 0.2,
        max_tokens: maxTokens
      });
      const retryText = retryResponse.choices[0].message.content || '';
      if (!hasWrongJurisdiction(retryText)) {
        text = retryText;
      }
    } catch (e) {
      console.warn('Retry failed, using original:', e.message);
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
  sessions.set(ctx.from.id, { mode, status: null, incident: null, history: [] });

  await ctx.answerCallbackQuery();

  const kb = new InlineKeyboard()
    .text('👤 Свидетель', 'st:witness').row()
    .text('🚨 Подозреваемый', 'st:suspect').row()
    .text('⚖️ Обвиняемый', 'st:accused').row()
    .text('🛡️ Потерпевший', 'st:victim').row()
    .text('📋 Истец', 'st:plaintiff').row()
    .text('📋 Ответчик', 'st:defendant');

  await ctx.reply('*Выберите свой процессуальный статус:*', {
    parse_mode: 'Markdown',
    reply_markup: kb
  });
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
    '• /start — начать\n' +
    '• /reset — сбросить\n' +
    '• /finish — итог тренировки\n' +
    '• /help — справка\n\n' +
    '📚 Используются статьи УК РК, УПК РК и Конституции РК.',
    { parse_mode: 'Markdown' }
  );
});

// ============ /finish ============
bot.command('finish', async (ctx) => {
  const sess = sessions.get(ctx.from.id);
  if (!sess || !sess.incident) {
    return ctx.reply('Нет активной сессии.');
  }

  const allText = sess.incident + ' ' + sess.history.map(m => m.content).join(' ');
  const relevant = findRelevantArticles(allText, 5);

  const summaryPrompt = `⚠️ ТОЛЬКО РУССКИЙ. ⚠️ ТОЛЬКО законы КАЗАХСТАНА.
Подведи итог: сильные стороны, слабые, что повторить. Кратко.

ИНЦИДЕНТ: ${sess.incident}
ДИАЛОГ: ${sess.history.map(m => m.content).join('\n\n')}

СТАТЬИ КАЗАХСТАНА:
${buildLawsContext(relevant)}`;

  try {
    await ctx.replyWithChatAction('typing');
    const answer = await callAI(summaryPrompt, 1200);
    await ctx.reply('🎓 *ИТОГ*\n\n' + answer, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(e);
    await ctx.reply('Ошибка. Попробуйте ещё раз.');
  }
});

// ============ HINT ============
bot.callbackQuery('hint', async (ctx) => {
  const sess = sessions.get(ctx.from.id);
  if (!sess) return ctx.answerCallbackQuery({ text: 'Начните с /start' });
  if (sess.mode === 'exam') {
    return ctx.answerCallbackQuery({ text: 'В режиме экзамена подсказки отключены', show_alert: true });
  }

  await ctx.answerCallbackQuery();

  const lastQuestion = sess.history.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
  const query = sess.incident + ' ' + lastQuestion;
  const relevant = findRelevantArticles(query, 3);
  const histText = sess.history.map(m => (m.role === 'user' ? '👤 ' : '🤖 ') + m.content).join('\n\n');

  try {
    await ctx.replyWithChatAction('typing');
    const answer = await callAI(
      buildHintPrompt(sess.status, sess.incident, histText, relevant),
      300
    );
    await ctx.reply(answer, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(e);
    await ctx.reply('Ошибка подсказки.');
  }
});

// ============ MAIN ============
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  const userId = ctx.from.id;
  const sess = sessions.get(userId);

  if (!sess) return ctx.reply('Начните с /start');
  if (!sess.mode) return ctx.reply('Выберите режим: /start');
  if (!sess.status) return ctx.reply('Выберите статус: /start');

  // ========== ПЕРВЫЙ ИНЦИДЕНТ ==========
  if (!sess.incident) {
    sess.incident = text;
    sess.history = [{ role: 'user', content: 'Инцидент: ' + text }];

    await ctx.reply('⏳ Готовлю первый вопрос...');

    const relevant = findRelevantArticles(text, 5);
    console.log(`🔍 RAG: найдено ${relevant.length} статей для КЗ`);

    try {
      await ctx.replyWithChatAction('typing');
      const histText = sess.history.map(m => m.content).join('\n\n');
      const question = await callAI(
        buildQuestionPrompt(sess.status, sess.incident, histText, relevant),
        500
      );
      sess.history.push({ role: 'assistant', content: question });

      const kb = new InlineKeyboard();
      if (sess.mode === 'beginner') {
        kb.text('💡 Подсказка', 'hint').row();
      }
      kb.text('🎓 Завершить тренировку', 'finish_action');

      await ctx.reply(question, { parse_mode: 'Markdown', reply_markup: kb });
    } catch (e) {
      console.error('AI error:', e);
      await ctx.reply('Ошибка ИИ. Попробуйте /start заново.');
    }
    return;
  }

  // ========== ОТВЕТ ПОЛЬЗОВАТЕЛЯ ==========
  sess.history.push({ role: 'user', content: text });

  await ctx.reply('⏳ Анализирую ответ...');

  const lastQuestion = sess.history.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
  const query = lastQuestion + ' ' + text;
  const relevant = findRelevantArticles(query, 5);
  console.log(`🔍 RAG: найдено ${relevant.length} статей для оценки`);

  try {
    await ctx.replyWithChatAction('typing');

    const histText = sess.history.map(m => (m.role === 'user' ? '👤 ' : '🎭 ') + m.content).join('\n\n');
    const combined = await callAI(
      buildCombinedPrompt(sess.status, sess.incident, histText, relevant),
      900
    );

    const parts = combined.split(/\n-{3,}\n/);
    const evaluation = parts[0] ? parts[0].trim() : combined;
    const nextQuestion = parts[1] ? parts[1].trim() : '';

    await ctx.reply(evaluation, { parse_mode: 'Markdown' });

    if (nextQuestion) {
      sess.history.push({ role: 'assistant', content: nextQuestion });

      const kb = new InlineKeyboard();
      if (sess.mode === 'beginner') {
        kb.text('💡 Подсказка', 'hint').row();
      }
      kb.text('🎓 Завершить тренировку', 'finish_action');

      await ctx.reply(nextQuestion, { parse_mode: 'Markdown', reply_markup: kb });
    }

  } catch (e) {
    console.error('AI error:', e);
    await ctx.reply('⚠️ ИИ временно недоступен. Отправьте сообщение через 30 секунд.');
  }
});

// ============ FINISH ACTION ============
bot.callbackQuery('finish_action', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply('Отправьте /finish для итоговой оценки.');
});

// ============ ЗАПУСК С RETRY ============
let retryCount = 0;
const MAX_RETRIES = 10;

async function startBot() {
  try {
    await bot.start({
      drop_pending_updates: true,
      onStart: (botInfo) => {
        console.log(`🚀 Dopros Trainer KZ started as @${botInfo.username}`);
        retryCount = 0;
      }
    });
  } catch (e) {
    const is409 = e.message && e.message.includes('409');
    if (is409 && retryCount < MAX_RETRIES) {
      retryCount++;
      const wait = Math.min(30 * retryCount, 120);
      console.log(`⚠️ 409 Conflict (attempt ${retryCount}/${MAX_RETRIES}). Retry in ${wait}s...`);
      setTimeout(startBot, wait * 1000);
    } else {
      console.error('❌ Fatal error:', e.message);
      process.exit(1);
    }
  }
}
startBot();

const httpApp = express();
httpApp.get('/', (req, res) => res.send('Dopros Trainer KZ running'));
const PORT = process.env.PORT || 3000;
httpApp.listen(PORT, () => console.log('HTTP server on port ' + PORT));
