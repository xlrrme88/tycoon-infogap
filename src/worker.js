// tycoon-infogap Worker
// 每天定时抓取 RSS 新闻 → Workers AI 生成信息差 → 存 KV → API 输出
// 前端静态资源由 [assets] 提供，/api/* 由本 Worker 处理

const AI_MODEL = '@cf/zhipu-ai/glm-4.7-flash'; // 主力：快、中文强
const AI_FALLBACK = '@cf/meta/llama-3.1-8b-instruct-fp8'; // 备用
const KEEP_DAYS = 30;

// 默认 RSS 新闻源（已验证可用；36kr 有反爬已弃用）。可在 README 指引下自行增减。
const FEEDS = [
  { name: 'IT之家', url: 'https://www.ithome.com/rss/' },
  { name: '少数派', url: 'https://sspai.com/feed' },
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
function parseRSS(xml, source) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const b of blocks.slice(0, 30)) {
    const title = extractTag(b, 'title');
    const link = extractTag(b, 'link');
    const pubRaw = extractTag(b, 'pubDate');
    const ts = pubRaw ? Date.parse(pubRaw) : NaN;
    const desc = extractTag(b, 'description').slice(0, 200);
    if (title) items.push({ title, link, source, ts: isNaN(ts) ? 0 : ts, desc });
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
      all.push(...parseRSS(xml, f.name));
    } catch (e) { /* 单个源失败不影响整体 */ }
  }
  const cutoff = Date.now() - 36 * 3600 * 1000;
  const seen = new Set();
  return all
    .filter((i) => i.ts >= cutoff && !seen.has(i.title) && seen.add(i.title))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 40);
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

const ITEMS_PROMPT = `你是「每日信息差」主编，面向关注科技、商业与投资机会的中文读者。
从下面的新闻候选中选出最重要的 7 条（优先覆盖：AI/大模型、半导体、生物医药、新材料、通信、机器人、新能源；优先选择有明确事实的硬新闻，避开纯观点、广告和重复话题）。
每条输出：
- fact：一句话讲清发生了什么，最重要的关键词用 <b></b> 包裹
- signal：一句话点出背后的趋势或机会，不超过 20 字
- source：该新闻的媒体名；link：原文链接
只输出以下结构的合法 JSON，不要输出任何解释文字：
{"items":[{"fact":"...","signal":"...","source":"...","link":"..."}]}
注意：所有内容必须基于候选新闻的真实信息，绝不编造事实、数据和日期；不确定的不写。字符串值内部不要使用英文双引号，如需引用请用中文引号“”。`;

const DEEPDIVE_PROMPT = `你是「每日信息差」主编。从下面「今日七条」中选 1 条最值得展开的，写「本期干货」：
- title：干货标题；summary：一句话理解（让小白也能懂）
- points：3 个信息差要点，每个含 heading 和 body（body 中的关键词可用 <b></b> 包裹）
- flow：4 步流程（每步 label 和 sub），如不适用可为空数组
- compare：左右对比 {a:{title,lines[3行]}, b:{title,lines[3行]}}
- takeaway：一句收藏要点总结
只输出以下结构的合法 JSON，不要输出任何解释文字：
{"deepdive":{"title":"...","summary":"...","points":[{"heading":"...","body":"..."}],"flow":[{"label":"...","sub":"..."}],"compare":{"a":{"title":"...","lines":["...","...","..."]},"b":{"title":"...","lines":["...","...","..."]}},"takeaway":"..."}}
注意：内容必须基于所给七条的真实信息，绝不编造；字符串值内部不要使用英文双引号，如需引用请用中文引号“”。`;

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
    .map((n, i) => `${i + 1}. [${n.source}] ${n.title}${n.link ? ' <' + n.link + '>' : ''}${n.desc ? ' —— ' + n.desc : ''}`)
    .join('\n');

  // 第一步：生成今日七条（短输出）
  const itemsRes = await aiJSON(env, ITEMS_PROMPT + '\n\n以下是过去36小时的新闻候选：\n' + list, 1200);
  if (!itemsRes.ok) return itemsRes;
  const items = itemsRes.data.items;
  if (!Array.isArray(items) || !items.length) return { ok: false, reason: 'ai_empty' };

  // 第二步：生成本期干货（短输出）。干货失败不卡死整期：先保存七条，干货置空，页面会显示"生成中"。
  const itemsText = items.map((it, i) => `${i + 1}. ${it.fact}（${it.source}）`).join('\n');
  const ddRes = await aiJSON(env, DEEPDIVE_PROMPT + '\n\n今日七条：\n' + itemsText, 2000);
  const deepdive = ddRes.ok ? ddRes.data.deepdive : null;

  return { ok: true, data: { items: items.slice(0, 7), deepdive } };
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
