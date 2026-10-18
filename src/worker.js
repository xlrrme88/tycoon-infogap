// tycoon-infogap Worker
// 每天定时抓取 RSS 新闻 → Workers AI 生成信息差 → 存 KV → API 输出
// 前端静态资源由 [assets] 提供，/api/* 由本 Worker 处理

const AI_MODEL = '@cf/zhipu-ai/glm-4.7-flash'; // 主力：快、中文强
const AI_FALLBACK = '@cf/meta/llama-3.1-8b-instruct-fp8'; // 备用
const KEEP_DAYS = 30;

// 科技产业新闻源（已验证可用）
const FEEDS = [
  { name: 'IT之家', url: 'https://www.ithome.com/rss/', lang: 'zh' },
  { name: 'FT中文网', url: 'http://www.ftchinese.com/rss/news', lang: 'zh' },
  { name: 'CNBC科技', url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html', lang: 'en' },
];

// 北京时间日期 YYYY-MM-DD
function shanghaiDate(d) {
  const t = d ? d.getTime() : Date.now();
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function stripTags(s) { return s.replace(/<[^>]*>/g, ''); }
function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}
function extractTag(block, tag) {
  const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
  if (!m) return '';
  let t = m[1].trim();
  const cdata = t.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata) t = cdata[1];
  return decodeEntities(stripTags(t)).trim();
}
function parseRSS(xml, feed) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const b of blocks.slice(0, 30)) {
    const title = extractTag(b, 'title');
    const link = extractTag(b, 'link');
    const pubRaw = extractTag(b, 'pubDate');
    const ts = pubRaw ? Date.parse(pubRaw) : NaN;
    const desc = extractTag(b, 'description').slice(0, 200);
    if (title) items.push({ title, link, source: feed.name, lang: feed.lang || 'zh', ts: isNaN(ts) ? 0 : ts, desc });
  }
  return items;
}

async function gatherNews() {
  const all = [];
  for (const f of FEEDS) {
    try {
      const r = await fetch(f.url, { headers: { 'User-Agent': 'tycoon-infogap/1.0 (+daily-digest)' } });
      if (!r.ok) continue;
      const xml = await r.text();
      all.push(...parseRSS(xml, f));
    } catch (e) { /* 单个源失败不影响整体 */ }
  }
  const cutoff = Date.now() - 36 * 3600 * 1000;
  const seenT = new Set(), seenL = new Set();
  return all
    .filter((i) => {
      if (i.ts < cutoff || seenT.has(i.title) || (i.link && seenL.has(i.link))) return false;
      seenT.add(i.title); if (i.link) seenL.add(i.link);
      return true;
    })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 50);
}

// 从 AI 返回文本中提取 JSON：先尝试 markdown 代码块，再尝试首尾大括号
// 解析失败时返回错误位置和上下文，便于定位
function extractJSON(text) {
  const candidates = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const m = text.match(/\{[\s\S]*\}/);
  if (m) candidates.push(m[0]);
  for (const s of candidates) {
    try {
      return { data: JSON.parse(s) };
    } catch (e) {
      const pm = String(e.message).match(/position (\d+)/);
      const pos = pm ? parseInt(pm[1], 10) : -1;
      const ctx = pos >= 0 ? s.slice(Math.max(0, pos - 60), pos + 60) : s.slice(0, 120);
      return { data: null, err: e.message + ' @pos ' + pos + ' ctx: ' + ctx };
    }
  }
  return { data: null, err: 'no_json_found head: ' + text.slice(0, 120) };
}

// 校验条目格式：数量、关键词加粗、signal 长度；返回 null 表示通过，否则返回原因
function itemsValid(items){
  if(!Array.isArray(items) || items.length < 18) return 'count=' + (Array.isArray(items) ? items.length : 0);
  for(const it of items){
    if(!it || !it.fact || !it.signal) return 'empty';
    if(it.fact.indexOf('<b>') < 0 && !/\*\*[^*]+\*\*/.test(it.fact)) return 'nobold';
    const sig = String(it.signal).replace(/\*\*/g, '').trim();
    if(sig.length < 2 || sig.length > 8) return 'signal=' + sig;
  }
  return null;
}

// 是否为可重试的 transient 错误（AI 超时/限流/网关错误）
function isTransient(reason){
  return /ai_call_failed/i.test(reason || '') && /3046|timeout|timed out|429|502|503|504/i.test(reason || '');
}

const ITEMS_PROMPT = `你是「每日信息差」主编，面向关注全球科技产业与投资机会的中文读者。
从下面的新闻候选中选出最重要的 20 条（领域：AI/大模型、半导体、生物医药、新材料、通信、机器人、新能源；优先硬科技产业突破、投融资并购、产业链动态；避开消费电子新品、数码配件、纯观点、广告和重复话题；英文新闻翻译成中文）。必须输出满 20 条。
严格遵守：
- 同一主题/同一事件最多选 2 条
- fact：一句话讲清发生了什么；关键词加粗只包裹 2-4 个核心词（关键数据、技术名、公司名），禁止整句加粗，禁止加粗超过 6 个词；用 <b></b> 包裹
- 外文专有名词必须准确翻译，不确定的保留英文原名，绝不编造中文名
- signal：4-8 字、该新闻独有的具体技术趋势标签，如"容错量子计算""新型存储流片"；禁止宽泛品类词（如"新能源汽车""人工智能""半导体""通信""投资""AI推动"），禁止与事实矛盾
- importance：重要程度，"high"（重大突破/重磅政策/大幅市场影响）或 "normal"
- source：该新闻的媒体名；link：原文链接
只输出以下结构的合法 JSON，不要输出任何解释文字：
{"items":[{"fact":"...","signal":"...","importance":"high","source":"...","link":"..."}]}
格式示例（严格照此格式，每条 fact 必须带 <b> 关键词）：
{"items":[
{"fact":"<b>谷歌</b>发布新一代<b>量子芯片 Willow</b>，<b>错误率降低约 40 倍</b>","signal":"容错量子计算","importance":"high","source":"科创板日报","link":"https://example.com/1"},
{"fact":"<b>铭芯启睿</b>首款<b>1Gb RRAM</b>芯片「<b>泰山一号</b>」完成流片，采用<b>28nm</b>工艺","signal":"新型存储流片","importance":"high","source":"界面新闻","link":"https://example.com/2"}
]}
注意：所有内容必须基于候选新闻的真实信息，绝不编造事实、数据和日期；不确定的不写。字符串值内部不要使用英文双引号，如需引用请用中文引号“”。`;

const DD_A_PROMPT = `你是「每日信息差」主编。从下面「今日资讯」中选 1 条最值得展开的，写「本期干货」上半部分：
- title：干货标题；summary：一句话理解（让小白也能懂）
- points：3 个信息差要点，每个含 heading 和 body（body 写 2-3 句实质分析，不要只罗列关键词；关键词用 <b></b> 或 ** ** 包裹 2-4 个）
- 优先选择硬科技产业突破、投融资并购相关的条目展开；不要选单一产品发布、日常波动这类缺乏深度的条目
- points 的 body 每段写 2-3 句实质分析，禁止"进而导致"式循环论证
只输出以下结构的合法 JSON，不要输出任何解释文字：
{"title":"...","summary":"...","points":[{"heading":"...","body":"..."}]}
注意：内容必须基于所给资讯的真实信息，绝不编造；字符串值内部不要使用英文双引号，如需引用请用中文引号“”。`;

const DD_B_PROMPT = `你是「每日信息差」主编。下面是本期干货已确定的标题、一句话理解和信息差要点，请补充下半部分：
- flow：4 步流程（每步 label 写具体步骤名，不要写"步骤1/步骤2"；每步含 label 和 sub），如不适用可为空数组
- compare：左右对比，只能有两个键 a 和 b（多一个键就是错误输出）；a.lines 和 b.lines 必须恰好 3 个字符串，每个不超过 14 字
- takeaway：一句收藏要点总结
只输出以下结构的合法 JSON，不要输出任何解释文字：
{"flow":[{"label":"...","sub":"..."}],"compare":{"a":{"title":"...","lines":["...","...","..."]},"b":{"title":"...","lines":["...","...","..."]}},"takeaway":"..."}
注意：内容必须基于所给信息的真实内容，绝不编造；字符串值内部不要使用英文双引号，如需引用请用中文引号“”。`;

// 调用 AI 生成并解析 JSON：
// - 调用抛错（超时等）→ 换备用模型重试
// - JSON 语法错误 → 用同一模型+错误反馈重试修正
async function aiJSON(env, prompt, maxTokens) {
  let modelIdx = 0;
  let feedback = '';
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const model = [AI_MODEL, AI_FALLBACK][modelIdx];
    let res = null;
    try {
      res = await env.AI.run(model, {
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: '你只输出合法的 JSON，不要输出任何解释文字。' },
          { role: 'user', content: prompt + (feedback ? '\n\n你上一次输出的 JSON 有语法错误：' + feedback + '。请修正后重新只输出合法的 JSON。' : '') },
        ],
      });
    } catch (e) {
      lastErr = 'ai_call_failed: ' + String((e && e.message) || e).slice(0, 200);
      feedback = '';
      modelIdx = 1; // 调用失败才换备用模型
      continue;
    }
    const text = typeof res.response === 'string' ? res.response : JSON.stringify(res);
    const parsed = extractJSON(text);
    if (parsed.data) return { ok: true, data: parsed.data };
    feedback = parsed.err; // 语法错误：同一模型重试修正，modelIdx 不变
    lastErr = 'ai_bad_json: ' + parsed.err;
  }
  return { ok: false, reason: lastErr };
}

async function generateDigest(env) {
  const news = await gatherNews();
  if (!news.length) return { ok: false, reason: 'no_recent_news' };
  const list = news
    .map((n, i) => `${i + 1}. [${n.source}]${n.lang === 'en' ? '[英文，需译成中文]' : ''} ${n.title}${n.link ? ' <' + n.link + '>' : ''}${n.desc ? ' —— ' + n.desc : ''}`)
    .join('\n');

  // 第一步：生成今日二十条（格式校验，不合格自动重试一次）
  const itemsPrompt = ITEMS_PROMPT + '\n\n以下是过去36小时的新闻候选：\n' + list;
  let itemsRes = await aiJSON(env, itemsPrompt, 2500);
  if (!itemsRes.ok && isTransient(itemsRes.reason)) {
    itemsRes = await aiJSON(env, itemsPrompt, 2500); // 超时/限流自动再试一次
  }
  if (!itemsRes.ok) return itemsRes;
  const vErr = itemsValid(itemsRes.data.items);
  if (vErr) {
    const retry = await aiJSON(env, itemsPrompt + '\n\n注意：上次输出格式不合格（' + vErr + '），请严格遵守格式要求（输出 20 条、每条 fact 用 <b> 标注 2-4 个关键词、signal 为 4-8 字趋势标签）重新输出。', 2500);
    if (retry.ok && !itemsValid(retry.data.items)) itemsRes = retry;
  }
  const items = itemsRes.data.items;
  if (!Array.isArray(items) || !items.length) return { ok: false, reason: 'ai_empty' };

  // 第二步：干货上半部分（标题+一句话理解+3个要点）
  const itemsText = items.map((it, i) => `${i + 1}. ${it.fact}（${it.source}）`).join('\n');
  const ddA = await aiJSON(env, DD_A_PROMPT + '\n\n今日资讯：\n' + itemsText, 1500);
  if (!ddA.ok) return { ok: true, data: { items: items.slice(0, 20), deepdive: null } }; // 降级：只要条目
  const a = ddA.data;

  // 第三步：干货下半部分（流程+对比+收藏要点）
  const ddB = await aiJSON(env, DD_B_PROMPT + '\n\n标题：' + a.title + '\n一句话理解：' + a.summary +
    '\n要点：\n' + (a.points || []).map((p) => '- ' + p.heading + '：' + p.body).join('\n'), 1500);
  const deepdive = ddB.ok
    ? { title: a.title, summary: a.summary, points: a.points, flow: ddB.data.flow, compare: ddB.data.compare, takeaway: ddB.data.takeaway }
    : { title: a.title, summary: a.summary, points: a.points }; // 部分降级：缺下半部分也照常显示

  return { ok: true, data: { items: items.slice(0, 20), deepdive } };
}

async function runDaily(env) {
  const date = shanghaiDate();
  const result = await generateDigest(env);
  if (!result.ok) {
    await env.DIGEST_KV.put('status', JSON.stringify({ ok: false, date, reason: result.reason, ts: Date.now() }));
    return result;
  }
  const digest = Object.assign({ date, generated_at: new Date().toISOString() }, result.data);
  await env.DIGEST_KV.put('digest:' + date, JSON.stringify(digest));
  let dates = JSON.parse((await env.DIGEST_KV.get('dates')) || '[]');
  if (!dates.includes(date)) dates.push(date);
  dates.sort();
  while (dates.length > KEEP_DAYS) {
    const old = dates.shift();
    await env.DIGEST_KV.delete('digest:' + old);
  }
  await env.DIGEST_KV.put('dates', JSON.stringify(dates));
  await env.DIGEST_KV.put('status', JSON.stringify({ ok: true, date, ts: Date.now() }));
  return { ok: true, date };
}

const json = (obj, status) =>
  new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/dates') {
      const dates = JSON.parse((await env.DIGEST_KV.get('dates')) || '[]');
      return json({ dates });
    }

    if (url.pathname === '/api/digest') {
      let date = url.searchParams.get('date');
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'bad_date' }, 400);
      if (!date) {
        const dates = JSON.parse((await env.DIGEST_KV.get('dates')) || '[]');
        date = dates.length ? dates[dates.length - 1] : null;
      }
      if (!date) return json({ error: 'not_found' }, 404);
      const data = await env.DIGEST_KV.get('digest:' + date);
      if (!data) return json({ error: 'not_found' }, 404);
      return new Response(data, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    if (url.pathname === '/api/status') {
      const s = await env.DIGEST_KV.get('status');
      return new Response(s || '{}', { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    // 诊断接口：只返回各绑定是否存在，不泄露任何密钥内容
    if (url.pathname === '/api/debug') {
      return json({ has_admin_key: !!env.ADMIN_KEY, kv_ok: !!env.DIGEST_KV, ai_ok: !!env.AI });
    }

    // 手动触发一次生成（部署后首次用；需要 ADMIN_KEY）
    // 用法：https://你的域名/api/refresh?key=你的密钥
    if (url.pathname === '/api/refresh') {
      const key = url.searchParams.get('key');
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ error: 'forbidden' }, 403);
      try {
        const r = await runDaily(env);
        return json(r);
      } catch (e) {
        return json({ ok: false, reason: 'exception: ' + String((e && e.message) || e).slice(0, 200) });
      }
    }

    return env.ASSETS.fetch(request);
  },

  // 每天 22:00 UTC = 北京时间次日 06:00
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDaily(env));
  },
};
