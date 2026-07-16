# 架构

织册部署为一个 Cloudflare Worker。Worker 同时服务 API 和 Astro 构建产物。

## 请求流

```text
浏览器
  -> Workers Static Assets 读取页面资源
  -> /api/* 进入 Hono
  -> D1 保存任务和材料索引
  -> Workflows 云端生成 PDF
  -> R2 保存最终 PDF
  -> R2 自定义域名 CDN（v2 artifact 302 redirect）
  -> Worker Range 兜底（v1 legacy / CDN 未配置）
```

## Cloudflare 绑定

- `ASSETS`：Astro 静态资源。
- `ZHICE_DB`：D1 数据库。
- `ZHICE_BUCKET`：R2 bucket。
- `PDF_WORKFLOW`：PDF 生成 Workflow。
- `MATERIAL_COORDINATOR`：同一教材 single-flight Durable Object。

## API

- `POST /api/jobs`：创建或复用任务（热缓存 < 1s，冷路径启动 Workflow）。
- `GET /api/jobs/:jobId`：查询任务状态。
- `GET /api/jobs/:jobId/events`：SSE 进度（带 heartbeat，10 分钟超时，断开自动停止）。
- `GET /api/materials/:contentId/download`：v2 → 302 CDN redirect，v1/fallback → Worker Range response。
- `GET /api/materials/:contentId/manifest`：浏览器兜底 manifest。
- `GET /api/page/:contentId/:page`：页图代理。

## 数据表

- `materials`：教材元数据和 R2 缓存索引（含 `manifest_checked_at`、`pdf_etag`、`pdf_version`）。
- `jobs`：生成任务（含 `generator_version`）。
- `usage_events`：最小匿名事件。
- `rate_limits`：短期限流计数。

## PDF 生成

云端生成采用流式 JPEG-to-PDF writer。页图以最多 6 路并发预取（共享外连信号量），按顺序写入 PdfWriter。R2 上传使用并行 multipart（最多 2 个分片并行）。Workflow 步骤独立可重试、使用确定性内容寻址 Key。

### 内容寻址

```
pdfVersion = SHA-256(imageSignature + "|" + generatorVersion)
r2Key = materials/<contentId>/<pdfVersion>.pdf
```

旧 R2 Key 不受影响，新生成使用短十六进制 key。

### 并发控制

HeaderSemaphore(6) 在抓页和 R2 上传之间共享，确保不掉到 Workers 6 连接限制之上。R2MultipartPdfSink 使用背压控制上传并发。

### 内存预算

- 当前分片缓冲区：8 MiB
- 最多 2 个上传中分片：16 MiB
- 最多 6 个页面缓冲区：~15 MiB
- 总计峰值：约 40 MiB（低于 Workers 128 MiB 限制）

## 公开入口保护

主流程不使用登录或人机验证组件，避免老师在受限网络中被第三方验证框卡住。`POST /api/jobs` 使用匿名 IP 哈希限流；运维能力只通过带 `OPS_TOKEN` 的 Ops API 暴露。
