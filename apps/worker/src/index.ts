import { Hono } from "hono";
import type { Env } from "./env";
import { MaterialCoordinator } from "./durable/material-coordinator";
import { jobsRoute } from "./routes/jobs";
import { materialsRoute, pageRoute } from "./routes/materials";
import { opsRoute } from "./routes/ops";
import { PdfWorkflow } from "./workflows/pdf-workflow";

const app = new Hono<{ Bindings: Env }>();

app.route("/api/jobs", jobsRoute);
app.route("/api/materials", materialsRoute);
app.route("/api/page", pageRoute);
app.route("/api/ops", opsRoute);

app.get("/api/health", (c) =>
  c.json({ ok: true, service: "zhice", time: new Date().toISOString() }),
);

app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export { MaterialCoordinator, PdfWorkflow };

export default app;
