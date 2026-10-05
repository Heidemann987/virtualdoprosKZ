// rag.js — локальный RAG для законов КЗ
const { pipeline } = require('@xenova/transformers');
const fs = require('fs');
const path = require('path');

let embedder = null;
let lawsData = null;
let chunksIndex = null;

const MODEL_NAME = 'Xenova/multilingual-e5-small';
const CACHE_FILE = path.join(__dirname, '.rag-cache.json');

// ═══════════ ИНИЦИАЛИЗАЦИЯ EMBEDDER ═══════════
async function initEmbedder() {
  if (embedder) return embedder;
  console.log('🧠 Загружаю embeddings-модель...');
  embedder = await pipeline('feature-extraction', MODEL_NAME, {
    quantized: true // быстрее, чуть менее точно
  });
  console.log('✅ Embeddings готовы');
  return embedder;
}

// ═══════════ EMBED ФУНКЦИЯ ═══════════
async function embed(text) {
  const pipe = await initEmbedder();
  // e5 требует префикс "query: " для запросов и "passage: " для документов
  const result = await pipe(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data);
}

// Для документов — с префиксом passage
async function embedPassage(text) {
  return embed('passage: ' + text);
}

// Для запросов — с префиксом query
async function embedQuery(text) {
  return embed('query: ' + text);
}

// ═══════════ ЧАНКИНГ СТАТЕЙ ═══════════
function chunkArticle(article, maxLen = 600) {
  const text = (article.text || '').trim();
  if (!text) return [];
  if (text.length <= maxLen) return [text];

  const chunks = [];
  // Режем по точкам, сохраняя предложения
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

// ═══════════ ЗАГРУЗКА И ИНДЕКСАЦИЯ ═══════════
async function loadAndIndexLaws() {
  // Пробуем загрузить кэш
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      const lawsMtime = fs.statSync(path.join(__dirname, 'laws_KZ.json')).mtimeMs;
      if (cached.mtime === lawsMtime && cached.chunks?.length) {
        console.log(`📚 RAG: загружен кэш (${cached.chunks.length} чанков)`);
        chunksIndex = cached.chunks;
        return;
      }
    } catch (e) {
      console.warn('Кэш повреждён, переиндексация...');
    }
  }

  // Загружаем законы
  const raw = fs.readFileSync(path.join(__dirname, 'laws_KZ.json'), 'utf8');
  const data = JSON.parse(raw);
  lawsData = data.articles || data;

  if (!lawsData.length) {
    console.warn('⚠️ laws_KZ.json пуст');
    chunksIndex = [];
    return;
  }

  console.log(`📚 RAG: индексация ${lawsData.length} статей...`);
  await initEmbedder();

  const chunks = [];
  let count = 0;

  for (const art of lawsData) {
    const articleChunks = chunkArticle(art);
    for (let i = 0; i < articleChunks.length; i++) {
      const chunkText = `[${art.code || 'КЗ'} | ${art.article || ''} | ${art.title || ''}]\n${articleChunks[i]}`;
      const embedding = await embedPassage(chunkText);

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
      if (count % 20 === 0) {
        process.stdout.write(`  → ${count} чанков\r`);
      }
    }
  }

  console.log(`✅ RAG: проиндексировано ${chunks.length} чанков`);

  // Сохраняем кэш
  const lawsMtime = fs.statSync(path.join(__dirname, 'laws_KZ.json')).mtimeMs;
  fs.writeFileSync(CACHE_FILE, JSON.stringify({
    mtime: lawsMtime,
    model: MODEL_NAME,
    chunks
  }));
  console.log('💾 RAG: кэш сохранён в .rag-cache.json');

  chunksIndex = chunks;
}

// ═══════════ КОСИНУСНАЯ БЛИЗОСТЬ ═══════════
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ═══════════ ПОИСК ═══════════
async function findRelevantArticles(query, limit = 5) {
  if (!chunksIndex || !chunksIndex.length) {
    return keywordFallback(query, limit);
  }

  try {
    const queryVec = await embedQuery(query);

    // Считаем близость для всех чанков
    const scored = chunksIndex.map(c => ({
      chunk: c,
      score: cosineSimilarity(queryVec, c.embedding)
    }));

    // Топ-N
    scored.sort((a, b) => b.score - a.score);

    // Группируем по статье (берём лучший чанк из каждой)
    const seen = new Set();
    const result = [];
    for (const s of scored) {
      const key = `${s.chunk.code}|${s.chunk.article}|${s.chunk.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        code: s.chunk.code,
        article: s.chunk.article,
        title: s.chunk.title,
        text: s.chunk.text,
        keywords: s.chunk.keywords,
        score: s.score
      });
      if (result.length >= limit) break;
    }

    return result;
  } catch (e) {
    console.error('RAG поиск упал:', e.message);
    return keywordFallback(query, limit);
  }
}

// ═══════════ РЕЗЕРВНЫЙ ПОИСК ═══════════
function keywordFallback(query, limit) {
  if (!lawsData) return [];
  const q = query.toLowerCase();
  const words = q.replace(/[^\w\sа-яё]/gi, ' ').split(/\s+/).filter(w => w.length > 3);

  const scored = lawsData.map(art => {
    let score = 0;
    for (const kw of (art.keywords || [])) {
      const k = kw.toLowerCase();
      if (q.includes(k)) score += 3;
      for (const w of words) if (k.includes(w) || w.includes(k)) score += 1;
    }
    return { art, score };
  });

  return scored.filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.art);
}

// ═══════════ ЭКСПОРТ ═══════════
module.exports = {
  initRAG: loadAndIndexLaws,
  findRelevantArticles,
  embed,
  embedQuery,
  embedPassage
};
