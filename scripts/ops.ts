const baseUrl = process.env.ZHICE_BASE_URL ?? "http://127.0.0.1:8787";
const token = process.env.OPS_TOKEN;

const [command, value] = process.argv.slice(2);

if (!token) {
  console.error("OPS_TOKEN is required.");
  process.exit(1);
}

const headers = {
  authorization: `Bearer ${token}`,
};

switch (command) {
  case "stats":
    await printJson("/api/ops/stats");
    break;
  case "retry":
    if (!value) {
      throw new Error("Usage: pnpm ops:retry <jobId>");
    }
    await printJson(`/api/ops/jobs/${value}/retry`, { method: "POST" });
    break;
  case "purge":
    if (!value) {
      throw new Error("Usage: pnpm ops:purge <contentId>");
    }
    await printJson(`/api/ops/materials/${value}`, { method: "DELETE" });
    break;
  default:
    console.log(`Usage:
  pnpm ops:stats
  pnpm ops:retry <jobId>
  pnpm ops:purge <contentId>

Environment:
  ZHICE_BASE_URL=https://your-worker.example.com
  OPS_TOKEN=...
`);
}

async function printJson(path: string, init: RequestInit = {}): Promise<void> {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  const text = await response.text();
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
  if (!response.ok) {
    process.exit(1);
  }
}
