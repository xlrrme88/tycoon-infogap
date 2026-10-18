# tycoon-infogap · 富人信息差

每日自动更新的信息差日报（剪纸镂空风，深浅模式，可回看最近 30 天）。

## 目录结构

```
tycoon-infogap/
├── public/
│   └── index.html      # 前端页面（剪纸镂空风，调用 /api/* 动态加载数据）
├── src/
│   └── worker.js       # Cloudflare Worker：定时抓取 RSS → Workers AI 生成 → 存 KV → API 输出
├── wrangler.toml       # Worker 配置（资源目录、KV、AI、定时任务）
└── README.md           # 本文件
```

## 工作原理

1. 每天北京时间 06:00，Worker 的 cron 触发器自动运行
2. 抓取 RSS 新闻源（IT之家、少数派，可自行增减）过去 36 小时的新闻
3. 调用 Workers AI 生成「今日二十条（事实+信号解读+来源）」和「本期干货」深度解读
4. 结果存入 KV（保留最近 30 天）
5. 用户打开页面时，前端从 `/api/digest` 拉取数据渲染；日历可回看 30 天

## 部署步骤

### 1. 前置条件

- 一个 Cloudflare 账号（免费版即可）
- 安装 Node.js，然后安装 wrangler：`npm install -g wrangler`

### 2. 登录 Cloudflare

```bash
wrangler login
```

### 3. 创建 KV 命名空间

```bash
wrangler kv:namespace create DIGEST_KV
```

把返回的 `id` 填到 `wrangler.toml` 里 `REPLACE_WITH_KV_NAMESPACE_ID` 的位置。

### 4. 启用 Workers AI

在 Cloudflare Dashboard → Workers & Pages → AI 中启用（免费套餐有一定额度）。

### 5. 设置管理员密钥（用于手动触发首次生成）

```bash
wrangler secret put ADMIN_KEY
# 输入一个你自己定的长随机字符串，例如：openssl rand -hex 16 的输出
```

### 6. 部署

```bash
wrangler deploy
```

部署成功后会得到一个 `https://tycoon-infogap.<你的子域名>.workers.dev` 地址。

### 7. 手动触发首次生成

浏览器打开（把域名和密钥换成你的）：

```
https://tycoon-infogap.<你的子域名>.workers.dev/api/refresh?key=你的ADMIN_KEY
```

返回 `{"ok":true,"date":"2026-10-19"}` 即成功。再打开首页就能看到第一期内容。
之后每天北京时间 06:00 会自动生成，无需人工干预。

### 8. 绑定自定义域名（可选）

Cloudflare Dashboard → Workers & Pages → tycoon-infogap → Settings → Domains & Routes → Add Custom Domain，
输入你的域名（如 `info.yourdomain.com`），按提示配置 DNS 即可（域名已托管在 Cloudflare 时几乎一键完成）。

## 自定义

- **换新闻源**：改 `src/worker.js` 顶部的 `FEEDS` 数组（RSS 地址即可，已对单个源失败做了容错）
- **换 AI 模型**：改 `src/worker.js` 顶部的 `AI_MODEL`
- **改定时时间**：改 `wrangler.toml` 的 `crons`（注意是 UTC 时间，北京时间 = UTC+8）
- **改页面样式**：直接改 `public/index.html` 里的 CSS

## 接口说明

- `GET /api/dates` → `{"dates":["2026-10-18", ...]}` 有内容的日期列表
- `GET /api/digest?date=2026-10-18` → 当日完整 JSON（不传 date 返回最新一期）
- `GET /api/status` → 最近一次生成的状态
- `GET /api/refresh?key=...` → 手动触发一次生成（需 ADMIN_KEY）

## 费用说明

- Cloudflare Workers 免费版：每天 10 万次请求，足够个人使用
- Workers AI 免费版：每天一定量神经网络单元，生成一期日报通常只需几次调用
- KV 免费版：读写额度对本项目绰绰有余
