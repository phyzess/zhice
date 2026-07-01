import type { Env } from "../env";

export async function verifyTurnstile(
  env: Env,
  token: string | undefined,
  remoteIp: string | null,
): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret || secret.startsWith("1x000")) {
    return true;
  }
  if (!token) {
    return false;
  }

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      secret,
      response: token,
      remoteip: remoteIp ?? undefined,
    }),
  });
  const result = (await response.json()) as { success?: boolean };
  return result.success === true;
}

export async function checkRateLimit(
  env: Env,
  ip: string | null,
  scope: string,
  limit = 30,
  windowMs = 60 * 60 * 1000,
): Promise<boolean> {
  const key = await rateLimitKey(env, ip ?? "unknown", scope);
  const timestamp = Date.now();
  const windowStart = timestamp - (timestamp % windowMs);
  const expiresAt = windowStart + windowMs * 2;
  const existing = await env.ZHICE_DB.prepare(
    "SELECT count, window_start FROM rate_limits WHERE key = ?",
  )
    .bind(key)
    .first<{ count: number; window_start: number }>();

  if (!existing || existing.window_start !== windowStart) {
    await env.ZHICE_DB.prepare(
      `INSERT INTO rate_limits (key, window_start, count, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count, expires_at = excluded.expires_at`,
    )
      .bind(key, windowStart, 1, expiresAt)
      .run();
    return true;
  }

  if (existing.count >= limit) {
    return false;
  }

  await env.ZHICE_DB.prepare(
    "UPDATE rate_limits SET count = count + 1, expires_at = ? WHERE key = ?",
  )
    .bind(expiresAt, key)
    .run();
  return true;
}

export function requireOpsToken(request: Request, env: Env): Response | null {
  const expected = env.OPS_TOKEN;
  if (!expected) {
    return Response.json({ error: "OPS_TOKEN is not configured" }, { status: 503 });
  }
  const actual = request.headers.get("authorization");
  if (actual !== `Bearer ${expected}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

async function rateLimitKey(env: Env, ip: string, scope: string): Promise<string> {
  const pepper = env.RATE_LIMIT_PEPPER ?? "zhice-dev-pepper";
  const data = new TextEncoder().encode(`${scope}:${ip}`);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  return Array.from(signature)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
