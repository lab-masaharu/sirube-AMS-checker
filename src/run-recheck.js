// ============================================================
// sirube-ams-checker / 404再確認スクリプト 新版
// system_code: sys_ops_ams_checker
//
// 使用方法: node src/run-recheck.js [間隔秒数] [件数上限]
// 例:       node src/run-recheck.js 120      （120秒間隔・全件）
//           node src/run-recheck.js 1800     （1800秒=30分間隔・本番用）
//           node src/run-recheck.js 30 3     （30秒間隔・3件・動作確認用）
// 引数省略: デフォルト120秒・件数上限なし
//
// recheck-vanished.js を新構造（FreinsAdapter + RecheckEngine）で書き直した版。
// ロジック・安全策・引数インターフェースは同じ。振る舞いを変えない。
// ============================================================

import { chromium } from "playwright";
import pg from "pg";
import dotenv from "dotenv";
import { FreinsAdapter } from "./adapters/FreinsAdapter.js";
import { RecheckEngine } from "./core/RecheckEngine.js";

dotenv.config();

const SYSTEM_CODE = "sys_ops_ams_checker";
const DEFAULT_INTERVAL_SEC = 120;
const HEADLESS = (process.env.HEADLESS || "false").toLowerCase() === "true";

function log(level, action, metadata = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level, systemCode: SYSTEM_CODE, service: "run-recheck", action, metadata,
  }));
}

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5544", 10),
  user: process.env.DB_USER || "sirube",
  password: process.env.DB_PASSWORD || "sirube_local_pw",
  database: process.env.DB_NAME || "sirube_ams",
});

// adapter here: 他媒体に切り替えるときはここ1行を差し替える
const adapter = new FreinsAdapter();

async function main() {
  const intervalSec = parseInt(process.argv[2] || String(DEFAULT_INTERVAL_SEC), 10);
  if (isNaN(intervalSec) || intervalSec <= 0) {
    console.error("使用方法: node src/run-recheck.js [間隔秒数] [件数上限]");
    console.error("例:       node src/run-recheck.js 120        (テスト・全件)");
    console.error("          node src/run-recheck.js 1800       (本番: 30分)");
    console.error("          node src/run-recheck.js 30 3       (動作確認: 3件)");
    process.exit(1);
  }
  const queueLimit = process.argv[3] ? parseInt(process.argv[3], 10) : null;
  if (queueLimit !== null && (isNaN(queueLimit) || queueLimit <= 0)) {
    console.error("件数上限は正の整数で指定してください。例: node src/run-recheck.js 30 3");
    process.exit(1);
  }

  if (!process.env.FREINS_EMAIL || !process.env.FREINS_PASSWORD) {
    log("FATAL", "env_missing", { missing: ["FREINS_EMAIL", "FREINS_PASSWORD"] });
    process.exit(1);
  }

  const runId = `recheck_${adapter.mediaName}_${new Date().toISOString().replace(/[:.]/g, "").substring(0, 15)}`;
  const startTime = Date.now();
  log("INFO", "start", { media: adapter.mediaName, intervalSec, queueLimit, runId, headless: HEADLESS });

  // ===== DB: 再確認キュー取得（各 object_id の最新 judgment が vanished の物件）=====
  const dbClient = await pool.connect();
  let queue;
  try {
    const { rows } = await dbClient.query(`
      SELECT latest.object_id, latest.freins_id, latest.ams_status
      FROM (
        SELECT DISTINCT ON (sc.object_id)
          sc.object_id, p.freins_id, sc.ams_status, sc.judgment
        FROM status_checks sc
        JOIN properties p ON p.object_id = sc.object_id
        WHERE p.media = $1
          AND p.freins_id IS NOT NULL
          AND p.status = 'active'
        ORDER BY sc.object_id, sc.checked_at DESC
      ) latest
      WHERE latest.judgment = 'vanished'
      ORDER BY latest.object_id
    `, [adapter.mediaName]);

    // RecheckEngine が求める { objectId, mediaId, amsStatus } 形式に変換
    // queueLimit が指定された場合はその件数に絞る（動作確認用）
    const limitedRows = queueLimit ? rows.slice(0, queueLimit) : rows;
    queue = limitedRows.map(r => ({
      objectId: r.object_id,
      mediaId: r.freins_id,
      amsStatus: r.ams_status,
    }));
  } finally {
    dbClient.release();
  }

  log("INFO", "queue_loaded", { count: queue.length });
  if (queue.length === 0) {
    log("INFO", "no_targets", {});
    console.log("\n再確認キューは空です（vanished の物件なし）。\n");
    await pool.end();
    return;
  }

  console.log(`\n再確認キュー: ${queue.length} 件`);
  for (const item of queue) {
    console.log(`  object_id=${item.objectId}  mediaId=${item.mediaId}  ams_status=${item.amsStatus}`);
  }
  console.log(`\n間隔: ${intervalSec}秒 × 3ラウンド`);
  console.log(`推定所要時間: 約 ${Math.round((intervalSec * 3 + queue.length * 5 * 3) / 60)} 分\n`);

  // ===== Playwright 起動・ログイン → RecheckEngine で再確認 =====
  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage();

  const engine = new RecheckEngine({ pool, adapter, log });

  try {
    await adapter.login(page);
    await engine.run(page, queue, intervalSec * 1000, runId);
  } finally {
    await browser.close();
    log("INFO", "browser_closed", { elapsed_s: ((Date.now() - startTime) / 1000).toFixed(1) });
  }

  // ===== 結果サマリー =====
  const summaryClient = await pool.connect();
  try {
    const { rows: breakdown } = await summaryClient.query(
      `SELECT judgment, count(*)::int AS cnt
         FROM status_checks WHERE run_id = $1
         GROUP BY judgment ORDER BY judgment`,
      [runId]
    );
    const { rows: finals } = await summaryClient.query(
      `SELECT DISTINCT ON (sc.object_id)
          sc.object_id, p.freins_id, sc.ams_status, sc.media_status, sc.judgment, sc.note
         FROM status_checks sc
         JOIN properties p ON p.object_id = sc.object_id
        WHERE sc.run_id = $1
        ORDER BY sc.object_id, sc.checked_at DESC`,
      [runId]
    );
    const { rows: history } = await summaryClient.query(
      `SELECT sc.object_id, sc.checked_at, sc.judgment, sc.note
         FROM status_checks sc
        WHERE sc.run_id = $1
        ORDER BY sc.object_id, sc.checked_at`,
      [runId]
    );

    console.log("\n========== 404再確認 結果サマリー ==========");
    console.log(`run_id      : ${runId}`);
    console.log(`媒体        : ${adapter.mediaName}`);
    console.log(`対象件数    : ${queue.length} 件`);
    console.log(`間隔        : ${intervalSec} 秒`);
    console.log(`所要時間    : ${((Date.now() - startTime) / 1000).toFixed(1)} 秒`);
    console.log("\n--- judgment 内訳（再確認レコード合計） ---");
    for (const r of breakdown) console.log(`  ${r.judgment.padEnd(18)}: ${r.cnt} 件`);
    console.log("\n--- 物件ごとの最終確定結果 ---");
    for (const f of finals) {
      console.log(`  [${f.judgment}] object_id=${f.object_id}  freins_id=${f.freins_id}`);
      console.log(`          AMS: ${f.ams_status} / 媒体: ${f.media_status ?? "(なし)"}`);
      console.log(`          note: ${f.note}`);
    }
    if (history.length > 0) {
      console.log("\n--- 全ラウンド履歴（append-only 確認） ---");
      let lastId = null;
      for (const h of history) {
        if (h.object_id !== lastId) {
          console.log(`  object_id=${h.object_id}`);
          lastId = h.object_id;
        }
        console.log(`    ${h.checked_at.toISOString().substring(11, 19)}  [${h.judgment}]  ${h.note}`);
      }
    }
    console.log("============================================\n");
  } finally {
    summaryClient.release();
    await pool.end();
  }
}

main().catch((err) => {
  log("ERROR", "recheck_failed", { message: err.message });
  console.error("\n[エラー]", err.message, "\n");
  process.exit(1);
});
