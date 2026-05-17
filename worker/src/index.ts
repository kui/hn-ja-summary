import type { KVNamespace } from "@cloudflare/workers-types";

interface Env {
  KV: KVNamespace;
  WORKERS_DOMAIN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/feed.xml") return handleFeed(env);

    const m = path.match(/^\/items\/(\d+)$/);
    if (m) return handleItem(env, m[1]);

    return new Response("Not found", { status: 404 });
  },
};

async function handleFeed(env: Env): Promise<Response> {
  const feed = await env.KV.get("feed");
  const body = feed ?? emptyFeed();
  return new Response(body, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

async function handleItem(env: Env, id: string): Promise<Response> {
  const html = await env.KV.get(`item:${id}`);
  if (!html) return new Response("Item not found", { status: 404 });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

function emptyFeed(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>HN Summary Feed</title>
    <link>https://news.ycombinator.com</link>
    <description>Summarized Hacker News trending articles (日本語)</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
  </channel>
</rss>`;
}
