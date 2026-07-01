# 部署

## Cloudflare 资源

需要 Workers Paid。

创建资源：

```bash
wrangler d1 create zhice
wrangler r2 bucket create zhice
```

把 D1 `database_id` 写入 `wrangler.jsonc`。

设置 secrets：

```bash
wrangler secret put OPS_TOKEN
wrangler secret put RATE_LIMIT_PEPPER
```

应用 migration：

```bash
wrangler d1 migrations apply ZHICE_DB --remote
```

部署：

```bash
pnpm deploy
```
