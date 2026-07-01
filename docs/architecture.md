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
```

## Cloudflare 绑定

- `ASSETS`：Astro 静态资源。
- `ZHICE_DB`：D1 数据库。
- `ZHICE_BUCKET`：R2 bucket。
- `PDF_WORKFLOW`：PDF 生成 Workflow。
- `MATERIAL_COORDINATOR`：同一教材 single-flight Durable Object。

## API

- `POST /api/jobs`：创建或复用任务。
- `GET /api/jobs/:jobId`：查询任务状态。
- `GET /api/jobs/:jobId/events`：SSE 进度。
- `GET /api/materials/:contentId/download`：下载 R2 PDF。
- `GET /api/materials/:contentId/manifest`：浏览器兜底 manifest。
- `GET /api/page/:contentId/:page`：页图代理。

## 数据表

- `materials`：教材元数据和 R2 缓存索引。
- `jobs`：生成任务。
- `usage_events`：最小匿名事件。
- `rate_limits`：短期限流计数。

## 公开入口保护

主流程不使用登录或人机验证组件，避免老师在受限网络中被第三方验证框卡住。`POST /api/jobs` 使用匿名 IP 哈希限流；运维能力只通过带 `OPS_TOKEN` 的 Ops API 暴露。

## PDF 生成

云端生成采用流式 JPEG-to-PDF writer。页图按顺序读取，JPG 原样嵌入 PDF，输出通过 R2 multipart upload 写入，避免整本 PDF 常驻内存。
