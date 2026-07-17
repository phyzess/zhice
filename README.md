# 织册

![织册 Zhice](apps/web/public/logo-icon.png)

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
- 默认云端生成 PDF（6 路并发抓页 + 并行 R2 上传），结果缓存到 R2 并通过 CDN 分发。
- 热缓存命中 P50 < 1 秒直接返回下载入口。
- 支持断点续传下载（HEAD / Range / 206 / ETag / 304）。
- 云端失败或排队过久时，可改用浏览器本机生成（OPFS 流式写入，低内存占用）。
- 微信或手机浏览器会提示用户换系统浏览器，避免大文件下载失败。
- 公开可用，创建生成任务使用匿名限流保护。
- 不做登录、不做服务端用户历史、不做 `/admin` 页面。

## 性能

| 指标 | 值 |
|---|---|
| 205 页冷生成 | 约 90 秒 |
| 热缓存 P50 | 250ms |
| 下载吞吐 | 4.9 MB/s |
| CDN 延迟 | 80ms |
| 峰值内存 | ~40 MiB（低于 Workers 128 MiB） |

## 技术栈

- Vite+ / `vite-plus`
- Astro + TypeScript + Vite
- Hono on Cloudflare Workers
- Valibot + `@hono/valibot-validator`
- Tailwind CSS v4 + `@tailwindcss/vite`
- `unplugin-icons` + Lucide Iconify 包
- Oxlint + Oxfmt
- D1、R2、Workflows、Durable Objects

## 架构

```
浏览器
  -> Workers Static Assets 读取页面
  -> /api/* 进入 Hono
  -> D1 保存任务和材料索引
  -> Workflows 云端生成 PDF（6 路并发）
  -> R2 保存最终 PDF（2 路并行 multipart）
  -> R2 自定义域名 CDN（302 redirect）
```

PDF 采用内容寻址 Key：`SHA-256(imageSignature + "|" + generatorVersion)`，不可变、可缓存。

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

## 测试

```bash
pnpm test          # 单元测试
pnpm test:worker   # Worker 集成测试
pnpm test:browser  # 浏览器测试
pnpm test:e2e      # E2E 测试
```

## 性能基准

```bash
# 前 24 页对比 1 并发 vs 6 并发
pnpm benchmark

# 全 205 页
ZHICE_BENCH_FULL=1 pnpm benchmark
```

## 部署

1. 创建 D1 database，并把 `wrangler.jsonc` 中的 `database_id` 换成真实值。
2. 创建 R2 bucket，默认名为 `zhice`。
3. 设置 `OPS_TOKEN` 和 `RATE_LIMIT_PEPPER`。
4. 应用 D1 migration。
5. 配置 R2 自定义域名（可选），设为 `PDF_PUBLIC_BASE_URL`。

```bash
wrangler secret put OPS_TOKEN
wrangler secret put RATE_LIMIT_PEPPER
wrangler d1 migrations apply ZHICE_DB --remote
pnpm deploy
```

部署后验证真实云端链路：

```bash
OPS_TOKEN=... ZHICE_BASE_URL=https://your-domain.example pnpm verify:production
```

## 运维

```bash
OPS_TOKEN=... ZHICE_BASE_URL=https://your-domain.example pnpm ops:stats
OPS_TOKEN=... ZHICE_BASE_URL=https://your-domain.example pnpm ops:retry <jobId>
OPS_TOKEN=... ZHICE_BASE_URL=https://your-domain.example pnpm ops:purge <contentId>
OPS_TOKEN=... ZHICE_BASE_URL=https://your-domain.example pnpm ops:regenerate <contentId>
```

## 合规边界

织册只重组网页公开预览页图，不下载平台私有源 PDF，不绕过平台鉴权。请仅在拥有合法使用权限的教学、备课等场景中使用。
