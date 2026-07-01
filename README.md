# 织册

织册是一个即来即走的教材 PDF 整理工具。老师打开网页，粘贴国家中小学智慧教育平台教材链接，等待系统整理页面，下载 PDF 后即可关闭页面。

```text
粘贴教材链接
  -> 生成 PDF
  -> 查看进度
  -> 下载
  -> 本地最近下载可重复打开
```

## 功能

- 单页工作台：中心输入框、当前任务卡、本地最近下载。
- 默认云端生成 PDF，并把结果静默缓存到 R2。
- 云端失败或排队过久时，可改用浏览器本机生成。
- 微信或手机浏览器会提示用户换系统浏览器，避免大文件下载失败。
- 公开可用，但创建生成任务需要 Turnstile 和匿名限流。
- 不做登录、不做服务端用户历史、不做 `/admin` 页面。

## 技术栈

- Vite+ / `vite-plus`
- Astro + TypeScript + Vite
- Hono on Cloudflare Workers
- Valibot + `@hono/valibot-validator`
- Tailwind CSS v4 + `@tailwindcss/vite`
- `unplugin-icons` + Lucide Iconify 包
- Oxlint + Oxfmt
- D1、R2、Workflows、Durable Objects、Turnstile

## 本地开发

```bash
pnpm install
cp .env.example .dev.vars
pnpm db:migrate:local
pnpm dev
```

`pnpm dev` 会先构建 Astro 静态资源，再用 Wrangler dev 启动 Worker、Static Assets、D1、R2、Workflow 和 Durable Object 本地模拟。
Vite+ 仍用于 `pnpm build`、`pnpm check` 和 `pnpm test`；`pnpm dev:vp` 保留给排查 Cloudflare Vite runner。

本地服务启动后，可以跑样例教材的端到端下载验证：

```bash
pnpm verify:local
pdfinfo /tmp/zhice-local-sample.pdf
```

也可以只看前端：

```bash
pnpm dev:web
```

## 部署前准备

1. 创建 D1 database，并把 `wrangler.jsonc` 中的 `database_id` 换成真实值。
2. 创建 R2 bucket，默认名为 `zhice`。
3. 创建 Turnstile site，设置 `TURNSTILE_SECRET_KEY`。
4. 设置 `OPS_TOKEN` 和 `RATE_LIMIT_PEPPER`。
5. 应用 D1 migration。

```bash
wrangler secret put TURNSTILE_SECRET_KEY
wrangler secret put OPS_TOKEN
wrangler secret put RATE_LIMIT_PEPPER
wrangler d1 migrations apply ZHICE_DB --remote
pnpm deploy
```

部署后验证真实云端链路：

```bash
OPS_TOKEN=... ZHICE_BASE_URL=https://your-domain.example ZHICE_VERIFY_PURGE=1 pnpm verify:production
```

这个命令会通过受保护的 Ops API 触发一条教材生成任务，等待 Workflows 完成，下载 R2 PDF，核对 PDF 页数，并再次提交确认缓存命中。

## 合规边界

织册只重组网页公开预览页图，不下载平台私有源 PDF，不绕过平台鉴权。请仅在拥有合法使用权限的教学、备课等场景中使用。
