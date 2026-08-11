import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the live pricing workbench without sample quotes", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>FairVal Lab - Multi-Model Option Research<\/title>/i);
  assert.match(html, /DATA OFFLINE/);
  assert.match(html, /NO SAMPLE DATA/);
  assert.match(html, /No fabricated option prices are shown\./);
  assert.match(html, /Connect market data/);
  assert.doesNotMatch(html, /DEMO FEED|Demo market is active|741\.82/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/);
});

test("server-renders the outcome study with an explicit holdout and data gaps", async () => {
  const response = await render("/research");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Did the .cheap. options/);
  assert.match(html, /Interesting holdout/);
  assert.match(html, /Not proven/);
  assert.match(html, /above the observed trade/);
  assert.match(html, /0–10 DTE, with the holes left visible/);
  assert.match(html, /A screen, not an arbitrage claim/);
  assert.match(html, /NON-NEGOTIABLE LIMITATIONS/);
});

test("uses authenticated providers and intraday New York expiry timing", async () => {
  const [route, pricing, page] = await Promise.all([
    readFile(new URL("../app/api/market/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/pricing.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(route, /data\.alpaca\.markets/);
  assert.match(route, /APCA-API-KEY-ID/);
  assert.match(route, /api\.tradier\.com/);
  assert.match(route, /status:\s*credentials\.feed === "opra" \? "live" : "indicative"/);
  assert.doesNotMatch(route, /demoResponse|Illustrative chain/);
  assert.match(pricing, /America\/New_York/);
  assert.match(pricing, /settlementMinutes = 16 \* 60 \+ 15/);
  assert.match(pricing, /calculateCrr/);
  assert.match(pricing, /calculateTrinomial/);
  assert.match(pricing, /impliedVolatility/);
  assert.match(pricing, /sameTreeExercisePremium/);
  assert.match(page, /No fabricated option prices are shown/);
  assert.match(page, /OPRA · Algo Trader Plus/);
  assert.match(page, /Auto · OPRA if entitled/);
  assert.match(page, /NEEDS TRADIER/);
  assert.doesNotMatch(page, /demoResponse|DEMO FEED/);
});
