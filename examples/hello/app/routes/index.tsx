// M4: server-rendered React from the embedded isolate — no Node anywhere.

export const agent = {
  title: "Home",
  description: "Landing page for the hello example app.",
  crawl: true,
};

function Feature({ name, tier }: { name: string; tier: string }) {
  return (
    <li>
      <strong>{name}</strong> — {tier}
    </li>
  );
}

export default function Home({ request }: { request: { path: string } }) {
  return (
    <html>
      <head>
        <title>beater.js — hello</title>
      </head>
      <body>
        <h1>beater.js</h1>
        <p>One runtime for the agent-first web. Rendered server-side at {request.path}.</p>
        <ul>
          <Feature name="routes + SSR" tier="V8 (embedded)" />
          <Feature name="ML tools" tier="CPython (embedded)" />
          <Feature name="agent loop" tier="native Rust" />
        </ul>
        <p>
          Agents start here: <a href="/llms.txt">/llms.txt</a> ·{" "}
          <a href="/.well-known/beater.json">manifest</a>
        </p>
      </body>
    </html>
  );
}
