import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { applyHardGuards } from './llm-guards.mjs';
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
const model = 'gemini-3.5-flash-lite';
const blocked = /(^localhost$|^127\.|^0\.|^::1$|^169\.254\.|\.local$)/i;
const imageTypes = new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif']);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
const allowAnalyze = createRateLimiter(10, 60 * 60 * 1000);
const clean = value => value?.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 600) || '';
const meta = (html, key) => clean(html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)`, 'i'))?.[1] || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${key}["']`, 'i'))?.[1]);
const metricSchema = { type:'OBJECT', properties:{ score:{type:'INTEGER',minimum:0,maximum:100}, reason:{type:'STRING'} }, required:['score','reason'] };
const itemSchema = {
  type:'OBJECT',
  properties:{
    category:{type:'STRING',enum:['top','bottom','outer','dress','shoes','bag','accessory','unknown']},
    gender:{type:'STRING',enum:['male','female','unisex','unknown']},
    season:{type:'STRING',enum:['summer','winter','all','transitional','unknown']},
    formality:{type:'INTEGER',minimum:0,maximum:2},
    fit:{type:'STRING',enum:['slim','regular','wide','oversized','unknown']},
    pattern:{type:'STRING',enum:['plain','pattern','unknown']},
    material:{type:'STRING'}, dominant_colors:{type:'ARRAY',items:{type:'STRING'},maxItems:4},
    description:{type:'STRING'}
  },
  required:['category','gender','season','formality','fit','pattern','material','dominant_colors','description']
};
const responseSchema = {
  type:'OBJECT',
  properties:{
    score:{type:'INTEGER',minimum:0,maximum:100},
    verdict:{type:'STRING',enum:['추천','조건부 추천','신중 추천','비추천']},
    confidence:{type:'INTEGER',minimum:0,maximum:100},
    summary:{type:'STRING'},
    items:{type:'OBJECT',properties:{owned:itemSchema,product:itemSchema},required:['owned','product']},
    metrics:{type:'OBJECT',properties:{category:metricSchema,season:metricSchema,color:metricSchema,formality:metricSchema,silhouette:metricSchema,pattern:metricSchema,gender:metricSchema},required:['category','season','color','formality','silhouette','pattern','gender']},
    hard_conflicts:{type:'ARRAY',items:{type:'STRING'}},
    purchase_checks:{type:'ARRAY',items:{type:'STRING'},maxItems:4}
  },
  required:['score','verdict','confidence','summary','items','metrics','hard_conflicts','purchase_checks']
};

function safeUrl(value) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || blocked.test(url.hostname)) throw Error('unsafe url');
  return url;
}
async function fetchPublic(value) {
  const url=safeUrl(value);
  const response=await fetch(url,{headers:{'user-agent':'Mozilla/5.0 FitCheckPrototype/1.0'},signal:AbortSignal.timeout(12000)});
  if(!response.ok) throw Error('fetch failed');
  return {response,url};
}
async function pageInfo(value) {
  const {response,url}=await fetchPublic(value);
  const html=await response.text();
  const title=meta(html,'og:title')||clean(html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]);
  const description=meta(html,'og:description')||meta(html,'description');
  const image=meta(html,'og:image');
  return {title,image:image?new URL(image,url).href:'',text:`${title} ${description}`.slice(0,1200)};
}
async function imagePart(value) {
  const {response}=await fetchPublic(value);
  const mime=(response.headers.get('content-type')||'image/jpeg').split(';')[0];
  if(!imageTypes.has(mime)) throw Error('unsupported image');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length>8_000_000) throw Error('image too large');
  return {inlineData:{mimeType:mime,data:bytes.toString('base64')}};
}
async function readJson(req) {
  const chunks=[]; let size=0;
  for await (const chunk of req) {
    size+=chunk.length;
    if(size>15_000_000) throw Error('request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function analyze(body) {
  const key=process.env.GEMINI_API_KEY;
  if(!key) throw Object.assign(Error('Gemini API 키가 설정되지 않았어요.'),{status:503});
  if(!imageTypes.has(body.mimeType)||!/^[A-Za-z0-9+/=]+$/.test(body.imageData||'')) throw Error('지원하지 않는 사진이에요.');
  const product=await pageInfo(body.productUrl);
  if(!product.image) throw Error('상품 대표 이미지를 찾지 못했어요.');
  const prompt=`당신은 패션 호환성 평가자다. 첫 번째 이미지는 사용자가 가진 옷, 두 번째 이미지는 구매 후보 상품이다.
상품 페이지 정보: ${product.text}
착용 상황: ${body.occasion||'일상'}
각 옷의 카테고리, 착용 대상, 계절, 격식도, 핏, 패턴, 소재, 대표색을 먼저 분석한 뒤 두 아이템이 한 코디에서 보완 관계인지 평가하라.
카테고리와 계절의 직접 충돌은 색상이 좋아도 높은 점수를 주지 마라. 이미지에서 확실하지 않은 정보는 unknown으로 표시하라.
점수와 각 세부 점수의 이유는 서로 모순되지 않아야 하며, 한국어로 간결하게 작성하라.`;
  const request={
    contents:[{role:'user',parts:[
      {text:prompt},{text:'첫 번째 이미지: 사용자가 가진 옷'},
      {inlineData:{mimeType:body.mimeType,data:body.imageData}},
      {text:'두 번째 이미지: 구매 후보 상품'},
      await imagePart(product.image)
    ]}],
    generationConfig:{responseMimeType:'application/json',responseSchema}
  };
  const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{
    method:'POST',headers:{'content-type':'application/json','x-goog-api-key':key},
    body:JSON.stringify(request),signal:AbortSignal.timeout(30000)
  });
  const data=await response.json();
  if(!response.ok) throw Object.assign(Error(data.error?.message||'Gemini 분석에 실패했어요.'),{status:502});
  const text=data.candidates?.[0]?.content?.parts?.map(part=>part.text||'').join('');
  if(!text) throw Object.assign(Error('Gemini가 분석 결과를 반환하지 않았어요.'),{status:502});
  return {analysis:applyHardGuards(JSON.parse(text)),product,model,usage:data.usageMetadata};
}

createServer(async (req,res)=>{
  try {
    const origin=new URL(req.url,`http://${req.headers.host}`);
    if(origin.pathname==='/api/analyze'&&req.method==='POST'){
      const ip=(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();
      if(!allowAnalyze(ip)) {
        res.writeHead(429,{'content-type':'application/json','retry-after':'3600'});
        return res.end(JSON.stringify({error:'요청이 많아요. 한 시간 뒤에 다시 시도해 주세요.'}));
      }
      const data=await analyze(await readJson(req));
      res.writeHead(200,{'content-type':'application/json'});
      return res.end(JSON.stringify(data));
    }
    if(origin.pathname==='/api/image'){
      const {response}=await fetchPublic(origin.searchParams.get('url'));
      res.writeHead(200,{'content-type':response.headers.get('content-type')||'image/jpeg','cache-control':'no-store'});
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    const file=origin.pathname==='/'?'fit-check-prototype.html':origin.pathname.slice(1);
    if(file.includes('..')) throw Error('invalid file');
    const body=await readFile(new URL(`./${file}`,import.meta.url));
    res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream'});
    res.end(body);
  } catch(error) {
    res.writeHead(error.status||422,{'content-type':'application/json'});
    res.end(JSON.stringify({error:error.message||'요청을 처리하지 못했어요.'}));
  }
}).listen(port,'0.0.0.0',()=>console.log(`http://localhost:${port}`));
