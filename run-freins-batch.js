// ============================================================
// sirube-ams-checker / ふれんずアダプタ バッチ版 run-freins-batch.js
// system_code: sys_ops_ams_checker
//
// 使用方法: node run-freins-batch.js [件数上限] [オフセット]
// 例:       node run-freins-batch.js 10      （先頭10件）
//           node run-freins-batch.js 10 10   （11〜20件目）
// 引数省略: デフォルト10件・オフセット0（明示しない限り大量には回らない）
//
// 処理フロー:
//   1. DBの properties から media='freins' かつ status='active' を取得
//   2. 1件ずつ fetchFreinsStatus でふれんず詳細を確認
//   3. ams_status と突合し judgment を決定
//   4. status_checks に記録
//   5. v_latest_diffs から mismatch/vanished を表示
//
// 安全策（CLAUDE.md §11）:
//   - 1件ごとに 4〜6秒のランダム待機
//   - 403/429 → 即停止
//   - 連続エラー3件 → 異常停止
//   - セッション切れ → 自動再ログイン（1回まで）
// ============================================================

import { chromium } from "playwright";
import pg from "pg";
import dotenv from "dotenv";
import { loginFreins, fetchFreinsStatus, translateStatus } from "./fetch-freins.js";

dotenv.config();

const SYSTEM_CODE = "sys_ops_ams_checker";
const TENANT = "sirube_office";
const DEFAULT_BATCH_LIMIT = 10;
const MAX_CONSECUTIVE_ERRORS = 3;
const WAIT_MIN_MS = 4000;
const WAIT_RANGE_MS = 2000; // 4000〜6000ms

const FREINS_EMAIL = process.env.FREINS_EMAIL;
const FREINS_PASSWORD = process.env.FREINS_PASSWORD;
const HEADLESS = (process.env.HEADLESS || "false").toLowerCase() === "true";

function log(level, action, metadata = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level, systemCode: SYSTEM_CODE, service: "run-freins-batch", action, metadata,
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

// ============================================================
// AMS×ふれんず 突合ロジック（CLAUDE.md §11）
//
// 許可: 突合のみ。DB への写真は status_checks のみ（properties は変更しない）。
// ============================================================
function computeJudgment(amsStatus, fetchResult) {
  const { judgment: fetchJudgment, rawStatus, mediaStatus, note: fetchNote } = fetchResult;

  // エラー系
  if (fetchJudgment === "error") {
    return { dbJudgment: "error", note: fetchNote };
  }

  // 消失疑い
  if (fetchJudgment === "vanished_suspected") {
    return {
      dbJudgment: "vanished",
      note: fetchNote,
    };
  }

  // 詳細ページ取得成功: ams_status × mediaStatus で突合
  if (amsStatus === "公開") {
    if (mediaStatus === "open") {
      return { dbJudgment: "match", note: `取引状況: 「${rawStatus}」` };
    }
    // 公開中以外は全て mismatch（negotiating/unknown いずれも要確認）
    return {
      dbJudgment: "mismatch",
      note: `要注意・人間確認 / AMS公開 → ふれんず: 「${rawStatus}」`,
    };
  }

  if (amsStatus === "商談中") {
    if (mediaStatus === "negotiating") {
      return { dbJudgment: "match", note: `取引状況: 「${rawStatus}」` };
    }
    if (mediaStatus === "open") {
      // AMS商談中なのにふれんずが公開中 = 逆転（珍しいが記録）
      return {
        dbJudgment: "mismatch",
        note: `要注意・AMS商談中だがふれんず公開中: 「${rawStatus}」`,
      };
    }
    // unknown等
    return {
      dbJudgment: "mismatch",
      note: `要注意・人間確認 / AMS商談中 → ふれんず: 「${rawStatus}」`,
    };
  }

  // 予期しない ams_status 値
  return {
    dbJudgment: "error",
    note: `ams_status不明: ${amsStatus} / ふれんず: 「${rawStatus}」`,
  };
}

// ============================================================
// status_checks への一括INSERT
// ============================================================
async function insertStatusChecks(client, checks) {
  const sql = `
    INSERT INTO status_checks
      (tenant_id, object_id, checked_at, ams_status, media, media_status,
       judgment, review_status, note, run_id, system_code)
    VALUES ($1, $2, now(), $3, 'freins', $4, $5::judgment_t, 'pending', $6, $7, $8)
  `;
  for (const c of checks) {
    await client.query(sql, [
      TENANT, c.objectId, c.amsStatus,
      c.mediaStatus, c.dbJudgment,
      c.note, c.runId, SYSTEM_CODE,
    ]);
  }
}

// ============================================================
// main
// ============================================================
async function main() {
  const batchLimit = parseInt(process.argv[2] || String(DEFAULT_BATCH_LIMIT), 10);
  if (isNaN(batchLimit) || batchLimit <= 0) {
    console.error("件数上限は正の整数で指定してください。例: node run-freins-batch.js 10");
    process.exit(1);
  }
  const batchOffset = parseInt(process.argv[3] || "0", 10);
  if (isNaN(batchOffset) || batchOffset < 0) {
    console.error("オフセットは0以上の整数で指定してください。例: node run-freins-batch.js 10 10");
    process.exit(1);
  }

  const missing = [];
  if (!FREINS_EMAIL) missing.push("FREINS_EMAIL");
  if (!FREINS_PASSWORD) missing.push("FREINS_PASSWORD");
  if (missing.length) {
    log("FATAL", "env_missing", { missing });
    process.exit(1);
  }

  const runId = `freins_${new Date().toISOString().replace(/[:.]/g, "").substring(0, 15)}`;
  log("INFO", "start", { batchLimit, batchOffset, runId, headless: HEADLESS });

  // ===== DB: 対象物件を取得 =====
  const dbClient = await pool.connect();
  let properties;
  try {
    const { rows } = await dbClient.query(
      `SELECT object_id, freins_id, ams_status
         FROM properties
        WHERE media = 'freins'
          AND status = 'active'
          AND freins_id IS NOT NULL
        ORDER BY object_id
        LIMIT $1 OFFSET $2`,
      [batchLimit, batchOffset]
    );
    properties = rows;
  } finally {
    dbClient.release();
  }
  log("INFO", "properties_loaded", { count: properties.length, batchLimit, batchOffset });

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
    await loginFreins(page);

    for (let i = 0; i < properties.length; i++) {
      const { object_id: objectId, freins_id: freinsId, ams_status: amsStatus } = properties[i];
      log("INFO", "fetch_item", { i: i + 1, total: properties.length, objectId, freinsId, amsStatus });

      let fetchResult = await fetchFreinsStatus(page, freinsId);

      // セッション切れ → 再ログイン後リトライ（1回まで）
      if (fetchResult.judgment === "error" && fetchResult.note?.includes("セッション切れ")) {
        log("WARN", "session_relogin", { freinsId });
        await loginFreins(page);
        fetchResult = await fetchFreinsStatus(page, freinsId);
      }

      const { dbJudgment, note } = computeJudgment(amsStatus, fetchResult);
      const mediaStatus = fetchResult.mediaStatus ?? null;

      log("INFO", "item_result", {
        objectId, freinsId, amsStatus,
        rawStatus: fetchResult.rawStatus,
        mediaStatus, dbJudgment,
      });

      checks.push({ objectId, freinsId, amsStatus, mediaStatus, dbJudgment, note, runId });

      // 連続エラーチェック
      if (dbJudgment === "error") {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          log("ERROR", "consecutive_errors_stop", {
            count: consecutiveErrors, lastFreinsId: freinsId,
          });
          throw new Error(`連続エラーが ${MAX_CONSECUTIVE_ERRORS} 件。異常とみなして停止します。`);
        }
      } else {
        consecutiveErrors = 0;
      }

      // 待機（最後の件は不要）
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
    // judgment 内訳
    const { rows: breakdown } = await summaryClient.query(
      `SELECT judgment, count(*)::int AS cnt
         FROM status_checks
        WHERE run_id = $1
        GROUP BY judgment
        ORDER BY judgment`,
      [runId]
    );

    // mismatch/vanished の詳細
    const { rows: diffs } = await summaryClient.query(
      `SELECT s.object_id, p.freins_id, s.ams_status, s.media_status, s.judgment, s.note
         FROM status_checks s
         JOIN properties p ON p.object_id = s.object_id
        WHERE s.run_id = $1
          AND s.judgment IN ('mismatch', 'vanished')
        ORDER BY s.judgment, s.object_id`,
      [runId]
    );

    console.log("\n========== ふれんずバッチ結果サマリー ==========");
    console.log(`run_id   : ${runId}`);
    console.log(`処理件数 : ${checks.length} 件`);
    console.log(`所要時間 : ${((Date.now() - startTime) / 1000).toFixed(1)} 秒`);
    console.log("--- judgment 内訳 ---");
    for (const r of breakdown) {
      console.log(`  ${r.judgment.padEnd(18)}: ${r.cnt} 件`);
    }

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
    console.log("================================================\n");
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
