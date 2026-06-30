import fs from "node:fs";
import dotenv from "dotenv";
import { chromium } from "playwright";
import { FreinsAdapter } from "../adapters/FreinsAdapter.js";

dotenv.config();

const SYSTEM_CODE = "sys_ops_ams_checker";
const HEADLESS = (process.env.HEADLESS || "false").toLowerCase() === "true";

function log(level, action, metadata = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    systemCode: SYSTEM_CODE,
    service: "ams-web-diff",
    action,
    metadata,
  }));
}

function formatMoney(value) {
  if (value === null || value === undefined) return "-";
  return `${Number(value).toLocaleString("ja-JP")}円`;
}

async function main() {
  if (!fs.existsSync("results.json")) {
    throw new Error("results.json が見つかりません。先に crawl-ams.js を実行してください。");
  }

  const data = JSON.parse(fs.readFileSync("results.json", "utf-8"));
  const rows = (data.rows || []).filter((row) => row.media === "freins" && row.freinsId);
  const adapter = new FreinsAdapter();
  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage();

  const openToNegotiating = [];
  const openToVanished = [];
  const priceChanges = [];

  try {
    await adapter.login(page);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      log("INFO", "fetch_item", { i: i + 1, total: rows.length, objectId: row.objectId, freinsId: row.freinsId, amsStatus: row.amsStatus });
      const fetchResult = await adapter.fetchStatus(page, row.freinsId);

      if (row.amsStatus === "公開" && fetchResult.mediaStatus === "negotiating") {
        openToNegotiating.push({ objectId: row.objectId, freinsId: row.freinsId, note: fetchResult.note });
      }
      if (row.amsStatus === "公開" && fetchResult.mediaStatus === "vanished") {
        openToVanished.push({ objectId: row.objectId, freinsId: row.freinsId, note: fetchResult.note });
      }
      if (row.amsPrice !== null && fetchResult.price !== null && row.amsPrice !== fetchResult.price) {
        priceChanges.push({
          objectId: row.objectId,
          freinsId: row.freinsId,
          amsPrice: row.amsPrice,
          webPrice: fetchResult.price,
          diff: fetchResult.price - row.amsPrice,
          note: fetchResult.note,
        });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log("\n========== AMS→WEB差分一覧 ==========");
  console.log(`AMS公開中 → ふれんず商談中: ${openToNegotiating.length} 件`);
  if (openToNegotiating.length > 0) {
    console.log("object_id        | freins_id      | note");
    console.log("------------------|----------------|------------------------------");
    for (const r of openToNegotiating) {
      const note = String(r.note || "").replace(/\s+/g, " ").slice(0, 30);
      console.log(`${String(r.objectId).padEnd(16)} | ${String(r.freinsId).padEnd(14)} | ${note}`);
    }
  }

  console.log(`\nAMS公開中 → ふれんず掲載消失: ${openToVanished.length} 件`);
  if (openToVanished.length > 0) {
    console.log("object_id        | freins_id      | note");
    console.log("------------------|----------------|------------------------------");
    for (const r of openToVanished) {
      const note = String(r.note || "").replace(/\s+/g, " ").slice(0, 30);
      console.log(`${String(r.objectId).padEnd(16)} | ${String(r.freinsId).padEnd(14)} | ${note}`);
    }
  }

  console.log(`\n価格変更物件: ${priceChanges.length} 件`);
  if (priceChanges.length > 0) {
    console.log("object_id        | freins_id      | AMS価格   | WEB価格   | 差額      | note");
    console.log("------------------|----------------|-----------|-----------|-----------|------------------------------");
    for (const r of priceChanges) {
      const note = String(r.note || "").replace(/\s+/g, " ").slice(0, 30);
      console.log(`${String(r.objectId).padEnd(16)} | ${String(r.freinsId).padEnd(14)} | ${formatMoney(r.amsPrice).padEnd(9)} | ${formatMoney(r.webPrice).padEnd(9)} | ${formatMoney(r.diff).padEnd(9)} | ${note}`);
    }
  }

  console.log("====================================\n");
}

main().catch((err) => {
  log("ERROR", "diff_failed", { message: err.message });
  console.error("\n[エラー]", err.message, "\n");
  process.exit(1);
});