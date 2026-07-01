# 运维

织册没有 `/admin` 管理页面。运维入口只有受保护的 Ops API 和 CLI 脚本。

## 环境变量

- `OPS_TOKEN`：Ops API bearer token。
- `ZHICE_BASE_URL`：CLI 使用的服务地址，默认 `http://127.0.0.1:8787`。

## CLI

```bash
OPS_TOKEN=... ZHICE_BASE_URL=https://your-domain.example pnpm ops:stats
OPS_TOKEN=... ZHICE_BASE_URL=https://your-domain.example pnpm ops:retry <jobId>
OPS_TOKEN=... ZHICE_BASE_URL=https://your-domain.example pnpm ops:purge <contentId>
ZHICE_BASE_URL=http://localhost:8787 pnpm verify:local
OPS_TOKEN=... ZHICE_BASE_URL=https://your-domain.example ZHICE_VERIFY_PURGE=1 pnpm verify:production
```

## API

- `GET /api/ops/health`
- `GET /api/ops/stats`
- `POST /api/ops/verify`
- `POST /api/ops/jobs/:jobId/retry`
- `DELETE /api/ops/materials/:contentId`

所有请求都必须带：

```text
Authorization: Bearer <OPS_TOKEN>
```

## 缓存清理

`ops:purge` 会删除 R2 PDF，并把对应教材状态恢复为可重新生成。它不会删除用户浏览器本地历史。

## 生产验证

本地回归可先运行：

```bash
pnpm dev
pnpm verify:local
pdfinfo /tmp/zhice-local-sample.pdf
```

`pnpm verify:production` 用来验证真实 Cloudflare 资源，而不是本地 Miniflare 模拟。

它会：

- 调用受保护的 `POST /api/ops/verify` 创建云端生成任务。
- 轮询任务直到成功或失败。
- 下载生成的 R2 PDF，并核对 PDF 头和页数。
- 再次创建任务，确认同一教材可以命中服务端缓存。

环境变量：

- `OPS_TOKEN`：必填。
- `ZHICE_BASE_URL`：生产 Worker 地址。
- `ZHICE_SAMPLE_URL`：可选，默认使用数学七年级上册样例链接。
- `ZHICE_VERIFY_PURGE=1`：先清掉该教材的服务端 PDF 缓存，用于冷链路验证。
- `ZHICE_VERIFY_TIMEOUT_MS`：可选，默认 15 分钟。
