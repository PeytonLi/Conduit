#!/usr/bin/env node
/**
 * Capture public health endpoints into docs/evidence/artifacts/health/.
 * Requires APP_BASE_URL. Optional VOICE_BRIDGE_URL. No secrets read or written.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(repoRoot, "docs/evidence/artifacts/health");

function stamp() {
  return new Date().toISOString().replace(/[:-]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function fetchJson(label, baseUrl, pathname) {
  const url = new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _parseError: true, status: res.status, raw: text.slice(0, 2000) };
  }
  return {
    label,
    url: url.href,
    status: res.status,
    captured_at_utc: new Date().toISOString(),
    body,
  };
}

async function main() {
  const appBase = process.env.APP_BASE_URL;
  if (!appBase) {
    console.error("Set APP_BASE_URL to the public Conduit app URL (https://...).");
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  const ts = stamp();
  const slug = process.env.EVIDENCE_SNAPSHOT_SLUG?.replace(/[^a-z0-9-]/gi, "-") || "snapshot";

  const appPayload = await fetchJson("app", appBase, "/api/health");
  const appFile = path.join(outDir, `health-app-${ts}-${slug}.json`);
  await writeFile(appFile, `${JSON.stringify(appPayload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${path.relative(repoRoot, appFile)}`);

  const bridgeBase = process.env.VOICE_BRIDGE_URL;
  if (bridgeBase) {
    const bridgePayload = await fetchJson("bridge", bridgeBase, "/health");
    const bridgeFile = path.join(outDir, `health-bridge-${ts}-${slug}.json`);
    await writeFile(bridgeFile, `${JSON.stringify(bridgePayload, null, 2)}\n`, "utf8");
    console.log(`Wrote ${path.relative(repoRoot, bridgeFile)}`);
  } else {
    console.log("VOICE_BRIDGE_URL not set; skipped bridge health.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
