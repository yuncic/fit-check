import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import convertHeic from 'heic-convert';
import sharp from 'sharp';
import { createRateLimiter } from './rate-limit.mjs';

async function loadLocalEnv() {
  try {
    const source = await readFile(new URL('./.env', import.meta.url), 'utf8');
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^("|')(.*)\1$/, '$2');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

await loadLocalEnv();

const port = process.env.PORT || 4173;
const model = 'claude-haiku-4-5';
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const allowAnalyze = createRateLimiter(10, 60 * 60 * 1000);
const clientEvents = new Set(['landing_view', 'photo_selected', 'search_clicked', 'recommend_again']);
const sourceOf = value => (/^[A-Za-z0-9_-]{1,40}$/.test(value || '') ? value : 'direct');
const safeLabel = value => (/^[가-힣A-Za-z0-9 _-]{1,30}$/.test(value || '') ? value : undefined);
const sessionOf = value => (/^[a-f0-9-]{20,40}$/i.test(value || '') ? value : 'unknown');
const track = (event, source, details = {}) =>
  console.log(JSON.stringify({ event, source, ...details, timestamp: new Date().toISOString() }));

const itemSchema = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: ['top', 'bottom', 'outer', 'dress', 'shoes', 'unknown'] },
    season: { type: 'string', enum: ['summer', 'winter', 'all', 'transitional', 'unknown'] },
    fit: { type: 'string' },
    material: { type: 'string' },
    dominant_colors: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    description: { type: 'string' },
  },
  required: ['category', 'season', 'fit', 'material', 'dominant_colors', 'description'],
};
const recommendationSchema = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: ['top', 'bottom', 'outer', 'shoes'] },
    title: { type: 'string' },
    color: { type: 'string' },
    fit: { type: 'string' },
    material: { type: 'string' },
    season: { type: 'string', enum: ['summer', 'winter', 'all', 'transitional'] },
    search_query: { type: 'string' },
    reason: { type: 'string' },
    avoid: { type: 'string' },
  },
  required: ['category', 'title', 'color', 'fit', 'material', 'season', 'search_query', 'reason', 'avoid'],
};
const responseSchema = {
  type: 'object',
  properties: {
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    summary: { type: 'string' },
    style_direction: { type: 'string' },
    owned: itemSchema,
    recommendations: {
      type: 'array',
      items: recommendationSchema,
      minItems: 3,
      maxItems: 3,
    },
  },
  required: ['confidence', 'summary', 'style_direction', 'owned', 'recommendations'],
};

async function imageBlock(mime, bytes) {
  if (['image/heic', 'image/heif'].includes(mime)) {
    bytes = Buffer.from(await convertHeic({ buffer: bytes, format: 'JPEG', quality: 0.85 }));
  }
  bytes = await sharp(bytes)
    .rotate()
    .resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  if (bytes.length > 4_500_000) throw Error('사진을 충분히 줄이지 못했어요. 다른 사진으로 시도해 주세요.');
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: bytes.toString('base64') } };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 15_000_000) throw Error('request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function analyze(body) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(Error('Claude API 키가 설정되지 않았어요.'), { status: 503 });
  if (!imageTypes.has(body.mimeType) || !/^[A-Za-z0-9+/=]+$/.test(body.imageData || '')) {
    throw Error('지원하지 않는 사진이에요.');
  }
  const gender = { male: '남성', female: '여성' }[body.gender];
  if (!gender) throw Error('남성 또는 여성을 선택해 주세요.');
  const prompt = `당신은 온라인 쇼핑을 돕는 패션 스타일리스트다.
사진 속 사용자가 가진 옷 한 벌을 먼저 분석하고, 이 옷과 함께 입기 위해 구매하면 좋은 보완 아이템을 정확히 3개 추천하라.
착용 상황은 ${body.occasion || '일상'}이다.
추천 및 검색 대상은 ${gender}이다.

규칙:
- 사진 속 옷과 같은 카테고리를 반복하지 말고 실제 코디를 완성하는 서로 다른 카테고리 3개를 고른다.
- 상의·하의·아우터·신발 중에서 필요한 것만 고른다.
- ${gender} 상품의 디자인과 사이즈 체계를 기준으로 추천한다.
- 계절, 색의 명도와 채도, 소재감, 격식도, 실루엣을 함께 고려한다.
- style_direction은 "미니멀 캐주얼 - 그레이톤을 활용한 차분한 데일리 스타일"처럼 짧은 스타일명, 하이픈, 한 문장 설명 순서로 쓴다.
- 추천 제목은 "검정 스트레이트 슬랙스"처럼 색상·형태·카테고리가 한눈에 보이게 쓴다.
- search_query는 국내 패션 쇼핑몰에 그대로 입력할 수 있는 짧고 구체적인 한국어 검색어로 쓰되 성별 단어는 넣지 않는다.
- 특정 브랜드나 존재 여부를 확인할 수 없는 상품은 만들어내지 않는다.
- 이유와 피해야 할 조건을 한국어로 간결하게 설명한다.
- 사진에서 확실하지 않은 정보는 unknown으로 표시하고 신뢰도를 낮춘다.`;
  const request = {
    model,
    max_tokens: 1600,
    messages: [
      {
        role: 'user',
        content: [
          await imageBlock(body.mimeType, Buffer.from(body.imageData, 'base64')),
          { type: 'text', text: prompt },
        ],
      },
    ],
    tools: [
      {
        name: 'record_outfit_recommendations',
        description: '사진 속 옷 분석과 구매할 보완 아이템 3개를 지정된 구조로 기록한다.',
        input_schema: responseSchema,
      },
    ],
    tool_choice: { type: 'tool', name: 'record_outfit_recommendations' },
  };
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(Error(data.error?.message || '추천을 만들지 못했어요.'), { status: 502 });
  const analysis = data.content?.find(
    part => part.type === 'tool_use' && part.name === 'record_outfit_recommendations',
  )?.input;
  if (!analysis) throw Object.assign(Error('추천 결과를 받지 못했어요.'), { status: 502 });
  return { analysis, targetGender: body.gender, model, usage: data.usage };
}

createServer(async (req, res) => {
  try {
    const origin = new URL(req.url, `http://${req.headers.host}`);
    if (origin.pathname === '/api/analyze' && req.method === 'POST') {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
      if (!allowAnalyze(ip)) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600' });
        return res.end(JSON.stringify({ error: '요청이 많아요. 한 시간 뒤에 다시 시도해 주세요.' }));
      }
      const body = await readJson(req);
      const source = sourceOf(body.source);
      const session = sessionOf(body.session);
      const gender = safeLabel(body.gender);
      track('recommendation_started', source, { session, gender });
      let data;
      try {
        data = await analyze(body);
        track('recommendation_completed', source, {
          session,
          gender,
          categories: data.analysis.recommendations.map(item => item.category).join(','),
        });
      } catch (error) {
        track('recommendation_failed', source, { session, gender });
        throw error;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(data));
    }
    if (origin.pathname === '/api/track' && req.method === 'POST') {
      const body = await readJson(req);
      if (!clientEvents.has(body.event)) throw Error('invalid event');
      track(body.event, sourceOf(body.source), {
        session: sessionOf(body.session),
        category: safeLabel(body.category),
        shop: safeLabel(body.shop),
        gender: safeLabel(body.gender),
      });
      res.writeHead(204);
      return res.end();
    }
    const file = origin.pathname === '/' ? 'fit-check-prototype.html' : origin.pathname.slice(1);
    if (file.includes('..')) throw Error('invalid file');
    const body = await readFile(new URL(`./${file}`, import.meta.url));
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (error) {
    res.writeHead(error.status || 422, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error.message || '요청을 처리하지 못했어요.' }));
  }
}).listen(port, '0.0.0.0', () => console.log(`http://localhost:${port}`));
