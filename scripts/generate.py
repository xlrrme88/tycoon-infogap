#!/usr/bin/env python3
"""每日信息差生成脚本（GitHub Actions 定时运行）。
流程：抓新闻（Google News RSS + 集微网 + IT之家）→ Gemini 选 20 条 → Gemini 写干货 → 写 JSON 到 public/data/。
需要环境变量 GEMINI_API_KEY（Google AI Studio 申请）。
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

API_KEY = os.environ.get('GEMINI_API_KEY', '')
MODEL = 'gemini-2.0-flash'
API_URL = f'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent'

UA = 'tycoon-infogap/1.0 (+daily-digest)'

# ---------- 新闻抓取 ----------

def gn_url(q):
    return ('https://news.google.com/rss/search?q=' + urllib.parse.quote(q)
            + '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans')

FEEDS = [
    {'name': '集微网', 'url': 'https://www.laoyaoba.com/api/rss/hbb', 'use_source_tag': False},
    {'name': 'IT之家', 'url': 'https://www.ithome.com/rss/', 'use_source_tag': False},
    {'name': 'GN-半导体', 'url': gn_url('半导体芯片'), 'use_source_tag': True},
    {'name': 'GN-AI', 'url': gn_url('AI大模型'), 'use_source_tag': True},
    {'name': 'GN-医药', 'url': gn_url('生物医药创新药'), 'use_source_tag': True},
    {'name': 'GN-新能源', 'url': gn_url('新能源机器人'), 'use_source_tag': True},
]

def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode('utf-8', errors='ignore')

def strip_tags(s):
    s = re.sub(r'<!\[CDATA\[(.*?)\]\]>', r'\1', s, flags=re.S)
    s = re.sub(r'<[^>]+>', '', s)
    s = s.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
    s = s.replace('&quot;', '"').replace('&#39;', "'").replace('&nbsp;', ' ')
    return s.strip()

def parse_rss(xml, feed):
    items = []
    for m in re.finditer(r'<item[\s>].*?</item>', xml, re.S | re.I):
        b = m.group(0)
        def tag(t):
            mm = re.search(r'<%s[^>]*>(.*?)</%s>' % (t, t), b, re.S | re.I)
            return strip_tags(mm.group(1)) if mm else ''
        title, link, pub_raw = tag('title'), tag('link'), tag('pubDate')
        try:
            ts = datetime.strptime(pub_raw[:31].strip(), '%a, %d %b %Y %H:%M:%S %z').timestamp() if pub_raw else 0
        except Exception:
            ts = 0
        source = feed['name']
        if feed.get('use_source_tag'):
            sm = re.search(r'<source[^>]*>([^<]*)</source>', b, re.I)
            if sm and sm.group(1).strip():
                source = sm.group(1).strip()
        desc = tag('description')[:200]
        if title:
            items.append({'title': title, 'link': link, 'source': source,
                          'ts': ts or time.time(), 'desc': desc})
    return items[:30]

def gather_news():
    all_items = []
    for f in FEEDS:
        try:
            xml = fetch(f['url'])
            items = parse_rss(xml, f)
            print(f"  {f['name']}: {len(items)} 条", flush=True)
            all_items.extend(items)
        except Exception as e:
            print(f"  {f['name']}: 失败 ({str(e)[:60]})", flush=True)
    cutoff = time.time() - 36 * 3600
    seen_t, seen_l = set(), set()
    filtered = []
    for i in sorted(all_items, key=lambda x: -x['ts']):
        if i['ts'] < cutoff or i['title'] in seen_t or (i['link'] and i['link'] in seen_l):
            continue
        seen_t.add(i['title'])
        if i['link']:
            seen_l.add(i['link'])
        filtered.append(i)
    # 单源上限 12 条
    per_src, out = {}, []
    for i in filtered:
        c = per_src.get(i['source'], 0)
        if c >= 12:
            continue
        per_src[i['source']] = c + 1
        out.append(i)
        if len(out) >= 50:
            break
    return out

# ---------- Gemini 调用 ----------

def gemini(prompt, max_tokens=4000, tries=3):
    last_err = ''
    for _ in range(tries):
        try:
            body = json.dumps({
                'contents': [{'parts': [{'text': prompt}]}],
                'generationConfig': {'temperature': 0.7, 'maxOutputTokens': max_tokens},
            }).encode()
            req = urllib.request.Request(
                API_URL + '?key=' + API_KEY, data=body,
                headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=120) as r:
                d = json.load(r)
            text = d['candidates'][0]['content']['parts'][0]['text']
            data = extract_json(text)
            if data:
                return {'ok': True, 'data': data}
            last_err = 'bad_json'
        except Exception as e:
            last_err = str(e)[:120]
            time.sleep(3)
    return {'ok': False, 'reason': last_err}

def extract_json(text):
    m = re.search(r'```(?:json)?\s*([\s\S]*?)```', text, re.I)
    cands = [m.group(1).strip()] if m else []
    m2 = re.search(r'\{[\s\S]*\}', text)
    if m2:
        cands.append(m2.group(0))
    for s in cands:
        try:
            return json.loads(s)
        except Exception:
            continue
    return None

# ---------- 提示词（与 Worker 版同源） ----------

ITEMS_PROMPT = """你是「每日信息差」主编，面向关注全球科技产业与投资机会的中文读者。
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
注意：所有内容必须基于候选新闻的真实信息，绝不编造事实、数据和日期；不确定的不写。字符串值内部不要使用英文双引号，如需引用请用中文引号“”。"""

DEEPDIVE_PROMPT = """你是「每日信息差」主编。从下面「今日资讯」中选 1 条最值得展开的，写「本期干货」完整版，只输出以下结构的合法 JSON，不要输出任何解释文字：
{"title":"干货标题","summary":"一句话理解（让小白也能懂）","points":[{"heading":"要点1标题","body":"2-3 句实质分析，关键词用 <b></b> 包裹 2-4 个"},{"heading":"要点2标题","body":"..."},{"heading":"要点3标题","body":"..."}],"flow":[{"label":"步骤名","sub":"一句话说明"},{"label":"...","sub":"..."},{"label":"...","sub":"..."}],"compare":{"a":{"title":"此前","lines":["...","...","..."]},"b":{"title":"之后","lines":["...","...","..."]}},"takeaway":"一句话收藏要点"}
要求：
- 优先选择硬科技产业突破、投融资并购相关的条目展开；不要选单一产品发布、日常波动这类缺乏深度的条目
- points 的 body 每段写 2-3 句实质分析，禁止"进而导致"式循环论证
- flow：3-4 个步骤，展示事情如何演进
- compare：a/b 对比各 3 行短句，突出变化
- 所有内容基于今日资讯的真实信息，不编造"""

SIGNAL_BANNED = ['新能源汽车', '人工智能', '半导体', '通信', '投资', 'AI推动', 'AI技术',
                 '显示器', '笔记本', '电子支付', '游戏', '移动电源', '智能手机', '互联网',
                 '娱乐', '创业', '机器人维修', '终端AI应用']

def items_valid(items):
    if not isinstance(items, list) or len(items) < 18:
        return 'count=%d' % (len(items) if isinstance(items, list) else 0)
    for it in items:
        if not it or not it.get('fact') or not it.get('signal'):
            return 'empty'
        f = it['fact']
        if '<b>' not in f and not re.search(r'\*\*[^*]+\*\*', f):
            return 'nobold'
        segs = [re.sub(r'</?b>', '', x) for x in re.findall(r'<b>([\s\S]*?)</b>', f)]
        plain = re.sub(r'</?b>', '', f).replace('**', '')
        max_seg = max([len(x) for x in segs], default=0)
        if segs and max_seg / max(1, len(plain)) > 0.6:
            return 'overbold'
        sig = str(it['signal']).replace('**', '').strip()
        if not (2 <= len(sig) <= 8):
            return 'signal=' + sig
        if sig in SIGNAL_BANNED:
            return 'banned=' + sig
    return None

# ---------- 主流程 ----------

def main():
    if not API_KEY:
        print('缺少 GEMINI_API_KEY 环境变量', file=sys.stderr)
        sys.exit(1)
    tz = timezone(timedelta(hours=8))
    today = datetime.now(tz).date().isoformat()
    print(f'[{today}] 开始抓取新闻...', flush=True)
    news = gather_news()
    print(f'候选共 {len(news)} 条', flush=True)
    if not news:
        print('无新闻候选，退出', file=sys.stderr)
        sys.exit(1)
    cand_text = '\n'.join(
        f"{i+1}. [{n['source']}] {n['title']}" + (f" <{n['link']}>" if n['link'] else '')
        + (f" —— {n['desc']}" if n['desc'] else '')
        for i, n in enumerate(news))

    print('生成 20 条...', flush=True)
    r = gemini(ITEMS_PROMPT + '\n\n以下是过去36小时的新闻候选：\n' + cand_text, max_tokens=5000)
    if not r['ok']:
        print('20条生成失败:', r['reason'], file=sys.stderr)
        sys.exit(1)
    items = r['data'].get('items', [])
    err = items_valid(items)
    if err:
        print(f'格式校验未通过（{err}），重试一次...', flush=True)
        r2 = gemini(ITEMS_PROMPT + '\n\n以下是过去36小时的新闻候选：\n' + cand_text
                    + f'\n\n注意：上次输出格式不合格（{err}），请严格遵守格式要求重新输出。',
                    max_tokens=5000)
        if r2['ok'] and not items_valid(r2['data'].get('items', [])):
            items = r2['data']['items']
            print('重试通过', flush=True)
    items = items[:20]

    print('生成干货...', flush=True)
    items_text = '\n'.join(f"{i+1}. {it['fact']}（{it['source']}）" for i, it in enumerate(items))
    deepdive = None
    rd = gemini(DEEPDIVE_PROMPT + '\n\n今日资讯：\n' + items_text, max_tokens=3000)
    if rd['ok']:
        deepdive = rd['data']
        print('干货完成', flush=True)
    else:
        print('干货失败，降级（仅条目）:', rd['reason'], flush=True)

    out = {
        'date': today,
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'items': items,
        'deepdive': deepdive,
    }
    os.makedirs('public/data', exist_ok=True)
    with open(f'public/data/{today}.json', 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False)
    # 更新日期索引
    idx_path = 'public/data/index.json'
    idx = []
    if os.path.exists(idx_path):
        idx = json.load(open(idx_path, encoding='utf-8'))
    if today not in idx:
        idx.append(today)
    idx = sorted(set(idx))[-30:]
    json.dump(idx, open(idx_path, 'w', encoding='utf-8'), ensure_ascii=False)
    print(f'已写入 public/data/{today}.json（{len(items)} 条）', flush=True)

if __name__ == '__main__':
    main()
