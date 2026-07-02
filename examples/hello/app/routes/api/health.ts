// M1: runs inside beater's embedded V8 — no Node, no Deno.

// Agent Access Layer metadata: enriches /llms.txt and /sitemap.xml.
export const agent = {
  title: "Health check",
  description: "Liveness endpoint returning runtime status as JSON.",
  crawl: true,
};

interface HealthReport {
  ok: boolean;
  runtime: string;
  now: string;
}

export function GET() {
  const report: HealthReport = {
    ok: true,
    runtime: "beater.js",
    now: new Date().toISOString(),
  };
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
  };
}
