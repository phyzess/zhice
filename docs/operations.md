# 运维

织册没有 `/admin` 管理页面。运维入口只有受保护的 Ops API 和 CLI 脚本。

## 环境变量

- `OPS_TOKEN`：Ops API bearer token。
- `RATE_LIMIT_PEPPER`：限流 HMAC 密钥。
- `ZHICE_BASE_URL`：CLI 使用的服务地址，默认 `http://127.0.0.1:8787`。
- `CLOUDFLARE_ZONE_ID`：CDN zone ID（用于 purge-by-URL）。
- `CLOUDFLARE_API_TOKEN`：Cloudflare API token（本地或 CI，不上传到 Worker secrets）。
- `PDF_PUBLIC_BASE_URL`：R2 自定义域名 CDN 地址。

## CLI

```bash
OPS_TOKEN=... ZHICE_BASE_URL=https://your-domain.example pnpm ops:stats
OPS_TOKEN=... ZHICE_BASE_URL=https://your-domain.example pnpm ops:retry <jobId>
OPS_TOKEN=... ZHICE_BASE_URL=https://your-domain.example pnpm ops:purge <contentId>
OPS_TOKEN=... ZHICE_BASE_URL=https://your-domain.example pnpm ops:regenerate <contentId>
ZHICE_BASE_URL=http://localhost:8787 pnpm verify:local
OPS_TOKEN=... ZHICE_BASE_URL=https://your-domain.example ZHICE_VERIFY_PURGE=1 pnpm verify:production
```

## API

- `GET /api/ops/health`
- `GET /api/ops/stats`：任务、缓存、事件的聚合统计，包含过去一小时事件、平均 PDF 大小、排队超 5 分钟任务数。
- `POST /api/ops/verify`：冷/热路径验证。
- `POST /api/ops/jobs/:jobId/retry`：重试失败任务（必须先 claim lease）。
- `POST /api/ops/materials/:contentId/regenerate`：渐进迁移旧缓存。
- `DELETE /api/ops/materials/:contentId?force=true`：force=true 会释放单飞锁。

所有请求都必须带：

```text
Authorization: Bearer <OPS_TOKEN>
```

## 缓存清理

`ops:purge` 会删除 R2 PDF，清空数据库缓存引用，并返回 CDN URL（如果配置了 `PDF_PUBLIC_BASE_URL`）供本地 purge-by-URL 使用。force 模式下会释放 DO 单飞锁。

## 旧缓存迁移

上线后运行：

```bash
# 查询 legacy PDF
wrangler d1 execute ZHICE_DB --remote --command \
  "SELECT content_id, title, pdf_r2_key FROM materials WHERE pdf_version IS NULL AND status = 'ready' ORDER BY updated_at DESC"

# 逐个迁移
pnpm ops:regenerate <contentId>
```

不要批量并发。全部迁移完成前不要移除 legacy Worker 下载路径。

## 性能基准

```bash
# 默认只对前 24 页比较 1 并发和 6 并发
ZHICE_SAMPLE_URL="..." pnpm benchmark

# 全 205 页
ZHICE_SAMPLE_URL="..." ZHICE_BENCH_FULL=1 pnpm benchmark
```

输出 JSON：页数、总字节、墙钟时间、累计请求时间、最大单页、失败页、重试数。

## 生产验证

```bash
pnpm verify:production
```

环境变量：

- `OPS_TOKEN`：必填。
- `ZHICE_BASE_URL`：生产 Worker 地址。
- `ZHICE_SAMPLE_URL`：可选，默认使用数学七年级上册样例链接。
- `ZHICE_VERIFY_PURGE=1`：先清掉缓存，验证冷链路。
- `ZHICE_VERIFY_TIMEOUT_MS`：可选，默认 15 分钟。
- `ZHICE_VERIFY_COLD_TARGET_MS`：冷生成目标上限，默认 60 秒。
- `ZHICE_VERIFY_HOT_TARGET_MS`：热缓存目标上限，默认 2 秒。

验证项：PDF 签名、流式页数、HEAD（Content-Length/ETag）、Range（206 + Content-Range）、热缓存延迟。

## 回滚

### Worker 代码异常

使用 Cloudflare 版本回滚到上一版本。数据库迁移全部是新增字段，不需要回滚。

### 并发抓页导致上游不稳定

把配置改为 `PDF_FETCH_CONCURRENCY=2`、`PDF_UPLOAD_CONCURRENCY=1` 重新部署。仍有问题则设为 1。

### R2 CDN 异常

将 `PDF_PUBLIC_BASE_URL=""` 重新部署，所有下载自动回到 Worker Range 路径。

### Multipart v2 异常

回滚 Worker。旧 artifact 不受影响；v2 内容寻址对象可以保留，不会覆盖旧 Key。

### OPFS 浏览器异常

通过能力检测关闭 OPFS，使用旧 Blob/IndexedDB 路径。云端生成不受影响。

### Single-flight 锁异常

回滚 Worker；等待最长 30 分钟租约到期，或者通过 `ops:purge <contentId>`（force=true）清理。

### 数据状态异常

使用部署前的 D1 导出或 D1 Time Travel。不要删除 R2 对象，先恢复 D1 指针。
