// scripts/index_laws.js — переиндексация законов КЗ для RAG
// Запуск: npm run index-laws
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pipeline } = require('@xenova/transformers');

const MODEL_NAME = 'Xenova/multilingual-e5-small';
const LAWS_FILE = path.join(__dirname, '..', 'laws_KZ.json');
const CACHE_FILE = path.join(__dirname, '..', '.rag-cache.json');

// ═══════════ ЧАНКИНГ ═══════════
function chunkArticle(article, maxLen = 600) {
  const text = (article.text || '').trim();
  if (!text) return [];
  if (text.length <= maxLen) return [text];

  const chunks = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let current = '';

  for (const s of sentences) {
    if ((current + ' ' + s).length > maxLen) {
      if (current) chunks.push(current.trim());
      current = s;
    } else {
      current += (current ? ' ' : '') + s;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

// ═══════════ MAIN ═══════════
async function main() {
  console.log('🚀 Запуск индексации законов КЗ\n');

  if (!fs.existsSync(LAWS_FILE)) {
    console.error(`❌ Файл не найден: ${LAWS_FILE}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(LAWS_FILE, 'utf8');
  const data = JSON.parse(raw);
  const articles = data.articles || data;

  if (!articles.length) {
    console.error('❌ Массив articles пуст');
    process.exit(1);
  }

  console.log(`📚 Загружено статей: ${articles.length}`);
  console.log('🧠 Загружаю embeddings-модель...');
  console.log(`   (модель: ${MODEL_NAME})`);
  console.log('   Первый запуск — скачивание ~120 МБ, подождите...\n');

  const embedder = await pipeline('feature-extraction', MODEL_NAME, {
    quantized: true
  });
  console.log('✅ Модель готова\n');

  const chunks = [];
  let count = 0;
  const startTime = Date.now();

  for (const art of articles) {
    const articleChunks = chunkArticle(art);

    for (let i = 0; i < articleChunks.length; i++) {
      const chunkText = `[${art.code || 'КЗ'} | ${art.article || ''} | ${art.title || ''}]\n${articleChunks[i]}`;

      // Префикс passage: для документов (e5 требует)
      const result = await embedder('passage: ' + chunkText, {
        pooling: 'mean',
        normalize: true
      });
      const embedding = Array.from(result.data);

      chunks.push({
        code: art.code || 'КЗ',
        article: art.article || null,
        title: art.title || '',
        text: articleChunks[i],
        chunkIndex: i,
        keywords: art.keywords || [],
        embedding
      });

      count++;
      if (count % 10 === 0) {
        process.stdout.write(`  → ${count} чанков\r`);
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n✅ Проиндексировано: ${chunks.length} чанков за ${elapsed}с`);

  // Сохраняем кэш
  const lawsMtime = fs.statSync(LAWS_FILE).mtimeMs;
  const cache = {
    mtime: lawsMtime,
    model: MODEL_NAME,
    version: '1.0',
    indexedAt: new Date().toISOString(),
    chunks
  };

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  const sizeMB = (fs.statSync(CACHE_FILE).size / 1024 / 1024).toFixed(2);
  console.log(`💾 Кэш сохранён: ${CACHE_FILE}`);
  console.log(`   Размер: ${sizeMB} МБ`);
  console.log(`\n✨ Готово! Теперь запустите: npm start`);
}

main().catch((e) => {
  console.error('❌ Ошибка:', e.message);
  console.error(e.stack);
  process.exit(1);
});
