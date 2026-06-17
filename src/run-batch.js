// ============================================================
// sirube-ams-checker / ふれんずバッチ 新版
// system_code: sys_ops_ams_checker
//
// 使用方法: node src/run-batch.js [件数上限] [オフセット]
// 例:       node src/run-batch.js 10      （先頭10件）
//           node src/run-batch.js 10 10   （11〜20件目）
// 引数省略: デフォルト10件・オフセット0
//
// run-freins-batch.js を新構造（FreinsAdapter + 共通部品）で書き直した版。
// ロジック・安全策・引数インターフェースは同じ。振る舞いを変えない。
//
// アダプタを差し替えるときは "// adapter here" の1行だけ変える。
// ============================================================

import { chromium } from "playwright";
import pg from "pg";
import dotenv from "dotenv";
import { FreinsAdapter } from "./adapters/FreinsAdapter.js";
import { computeJudgment } from "./core/computeJudgment.js";
import { insertStatusChecks } from "./core/StatusCheckStore.js";

dotenv.config();

const SYSTEM_CODE = "sys_ops_ams_checker";
const DEFAULT_BATCH_LIMIT = 10;
const MAX_CONSECUTIVE_ERRORS = 3;
const WAIT_MIN_MS = 4000;
const WAIT_RANGE_MS = 2000;
const HEADLESS = (process.env.HEADLESS || "false").toLowerCase() === "true";

function log(level, action, metadata = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level, systemCode: SYSTEM_CODE, service: "run-batch", action, metadata,
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
  const batchLimit = parseInt(process.argv[2] || String(DEFAULT_BATCH_LIMIT), 10);
  if (isNaN(batchLimit) || batchLimit <= 0) {
    console.error("件数上限は正の整数で指定してください。例: node src/run-batch.js 10");
    process.exit(1);
  }
  const batchOffset = parseInt(process.argv[3] || "0", 10);
  if (isNaN(batchOffset) || batchOffset < 0) {
    console.error("オフセットは0以上の整数で指定してください。例: node src/run-batch.js 10 10");
    process.exit(1);
  }

  if (!process.env.FREINS_EMAIL || !process.env.FREINS_PASSWORD) {
    log("FATAL", "env_missing", { missing: ["FREINS_EMAIL", "FREINS_PASSWORD"] });
    process.exit(1);
  }

  const runId = `batch_${adapter.mediaName}_${new Date().toISOString().replace(/[:.]/g, "").substring(0, 15)}`;
  log("INFO", "start", { media: adapter.mediaName, batchLimit, batchOffset, runId, headless: HEADLESS });

  // ===== DB: 対象物件取得 =====
  const dbClient = await pool.connect();
  let properties;
  try {
    const { rows } = await dbClient.query(
      `SELECT object_id, freins_id, ams_status
         FROM properties
        WHERE media = $1
          AND status = 'active'
          AND freins_id IS NOT NULL
        ORDER BY object_id
        LIMIT $2 OFFSET $3`,
      [adapter.mediaName, batchLimit, batchOffset]
    );
    properties = rows;
  } finally {
    dbClient.release();
  }
  log("INFO", "properties_loaded", { count: properties.length });

  if (properties.length === 0) {
    log("INFO", "no_targets", {});
    await pool.end();
    return;
  }

  // ===== Playwright: ログイン → バッチ巡回 =====
  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage();
  const checks = [];
  let consecutiveErrors = 0;
  const startTime = Date.now();

  try {
    await adapter.login(page);

    for (let i = 0; i < properties.length; i++) {
      const { object_id: objectId, freins_id: freinsId, ams_status: amsStatus } = properties[i];
      log("INFO", "fetch_item", { i: i + 1, total: properties.length, objectId, freinsId, amsStatus });

      let fetchResult = await adapter.fetchStatus(page, freinsId);

      // セッション切れ → 再ログイン後リトライ（1回まで）
      if (fetchResult.judgment === "error" && fetchResult.note?.includes("セッション切れ")) {
        log("WARN", "session_relogin", { freinsId });
        await adapter.login(page);
        fetchResult = await adapter.fetchStatus(page, freinsId);
      }

      const { dbJudgment, note } = computeJudgment(amsStatus, fetchResult, adapter.mediaName);

      log("INFO", "item_result", {
        objectId, freinsId, amsStatus,
        rawStatus: fetchResult.rawStatus,
        mediaStatus: fetchResult.mediaStatus,
        judgment: dbJudgment,
      });

      checks.push({
        objectId, amsStatus,
        media: adapter.mediaName,
        mediaStatus: fetchResult.mediaStatus ?? null,
        judgment: dbJudgment,
        note,
        runId,
      });

      // 連続エラーチェック
      if (dbJudgment === "error") {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          log("ERROR", "consecutive_errors_stop", { count: consecutiveErrors, lastFreinsId: freinsId });
          throw new Error(`連続エラーが ${MAX_CONSECUTIVE_ERRORS} 件。異常とみなして停止します。`);
        }
      } else {
        consecutiveErrors = 0;
      }

      if (i < properties.length - 1) {
        const waitMs = WAIT_MIN_MS + Math.random() * WAIT_RANGE_MS;
        log("INFO", "rate_limit_wait", { ms: Math.round(waitMs) });
        await page.waitForTimeout(waitMs);
      }
    }
  } finally {
    await browser.close();
    log("INFO", "browser_closed", { elapsed_s: ((Date.now() - startTime) / 1000).toFixed(1) });
  }

  // ===== DB: status_checks に記録 =====
  const writeClient = await pool.connect();
  try {
    await writeClient.query("BEGIN");
    await insertStatusChecks(writeClient, checks);
    await writeClient.query("COMMIT");
    log("INFO", "status_checks_saved", { count: checks.length, runId });
  } catch (err) {
    await writeClient.query("ROLLBACK");
    throw err;
  } finally {
    writeClient.release();
  }

  // ===== 集計・サマリー =====
  const summaryClient = await pool.connect();
  try {
    const { rows: breakdown } = await summaryClient.query(
      `SELECT judgment, count(*)::int AS cnt
         FROM status_checks WHERE run_id = $1
         GROUP BY judgment ORDER BY judgment`,
      [runId]
    );
    const { rows: diffs } = await summaryClient.query(
      `SELECT s.object_id, p.freins_id, s.ams_status, s.media_status, s.judgment, s.note
         FROM status_checks s
         JOIN properties p ON p.object_id = s.object_id
        WHERE s.run_id = $1 AND s.judgment IN ('mismatch', 'vanished')
        ORDER BY s.judgment, s.object_id`,
      [runId]
    );

    console.log("\n========== バッチ結果サマリー ==========");
    console.log(`run_id   : ${runId}`);
    console.log(`媒体     : ${adapter.mediaName}`);
    console.log(`処理件数 : ${checks.length} 件`);
    console.log(`所要時間 : ${((Date.now() - startTime) / 1000).toFixed(1)} 秒`);
    console.log("--- judgment 内訳 ---");
    for (const r of breakdown) console.log(`  ${r.judgment.padEnd(18)}: ${r.cnt} 件`);
    if (diffs.length > 0) {
      console.log("\n--- mismatch / vanished 一覧 ---");
      for (const d of diffs) {
        console.log(`  [${d.judgment}] object_id=${d.object_id} freins_id=${d.freins_id}`);
        console.log(`          AMS: ${d.ams_status} / ふれんず: ${d.media_status}`);
        console.log(`          note: ${d.note}`);
      }
    } else {
      console.log("\nmismatch / vanished: なし");
    }
    console.log("=========================================\n");
  } finally {
    summaryClient.release();
    await pool.end();
  }
}

main().catch((err) => {
  log("ERROR", "batch_failed", { message: err.message });
  console.error("\n[エラー]", err.message, "\n");
  process.exit(1);
});
