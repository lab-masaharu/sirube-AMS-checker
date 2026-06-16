// ============================================================
// sirube-ams-checker / 404再確認スクリプト recheck-vanished.js
// system_code: sys_ops_ams_checker
//
// 使用方法: node recheck-vanished.js [間隔秒数]
// 例:       node recheck-vanished.js 120   （120秒間隔・テスト用）
//           node recheck-vanished.js 1800  （1800秒=30分間隔・本番用）
// 引数省略: デフォルト120秒（テスト用）
//
// ※ 動作パラメータは引数で渡す（.env に置かない: §13）
//
// 処理フロー:
//   1. status_checks の最新 judgment が vanished の物件を「再確認キュー」として取得
//   2. 指定間隔を挟みながら最大3回の再確認を実施
//   3. 途中でページが復活（detail が読める）→ その時点のステータスで確定しキューから除外
//   4. 3回すべて404 → vanished 確定（1巡目含め計4回404）
//   5. 各ラウンドの結果を status_checks に append-only で記録
//
// 安全策（CLAUDE.md §12）:
//   - 1件ごとに 4〜6秒のランダム待機
//   - 403/429 → 即停止
//   - 連続エラー3件 → 異常停止
// ============================================================

import { chromium } from "playwright";
import pg from "pg";
import dotenv from "dotenv";
import { loginFreins, fetchFreinsStatus } from "./fetch-freins.js";

dotenv.config();

const SYSTEM_CODE = "sys_ops_ams_checker";
const TENANT = "sirube_office";
const MAX_RECHECK_ROUNDS = 3;
const WAIT_MIN_MS = 4000;
const WAIT_RANGE_MS = 2000;
const MAX_CONSECUTIVE_ERRORS = 3;
const DEFAULT_INTERVAL_SEC = 120;

const FREINS_EMAIL = process.env.FREINS_EMAIL;
const FREINS_PASSWORD = process.env.FREINS_PASSWORD;
const HEADLESS = (process.env.HEADLESS || "false").toLowerCase() === "true";

function log(level, action, metadata = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level, systemCode: SYSTEM_CODE, service: "recheck-vanished", action, metadata,
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

// 復活したページのステータス突合（run-freins-batch.js の computeJudgment と同じロジック）
function computeDetailJudgment(amsStatus, fetchResult) {
  const { rawStatus, mediaStatus } = fetchResult;
  if (amsStatus === "公開") {
    if (mediaStatus === "open") return { judgment: "match", desc: `取引状況: 「${rawStatus}」` };
    return { judgment: "mismatch", desc: `要注意・人間確認 / AMS公開 → ふれんず: 「${rawStatus}」` };
  }
  if (amsStatus === "商談中") {
    if (mediaStatus === "negotiating") return { judgment: "match", desc: `取引状況: 「${rawStatus}」` };
    if (mediaStatus === "open") return { judgment: "mismatch", desc: `要注意・AMS商談中だがふれんず公開中: 「${rawStatus}」` };
    return { judgment: "mismatch", desc: `要注意・人間確認 / AMS商談中 → ふれんず: 「${rawStatus}」` };
  }
  return { judgment: "error", desc: `ams_status不明: ${amsStatus}` };
}

async function insertStatusCheck(client, { objectId, amsStatus, mediaStatus, judgment, note, runId }) {
  await client.query(
    `INSERT INTO status_checks
       (tenant_id, object_id, checked_at, ams_status, media, media_status,
        judgment, review_status, note, run_id, system_code)
     VALUES ($1, $2, now(), $3, 'freins', $4, $5::judgment_t, 'pending', $6, $7, $8)`,
    [TENANT, objectId, amsStatus, mediaStatus, judgment, note, runId, SYSTEM_CODE]
  );
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const intervalSec = parseInt(process.argv[2] || String(DEFAULT_INTERVAL_SEC), 10);
  if (isNaN(intervalSec) || intervalSec <= 0) {
    console.error("使用方法: node recheck-vanished.js [間隔秒数]");
    console.error("例:       node recheck-vanished.js 120   (テスト)");
    console.error("          node recheck-vanished.js 1800  (本番: 30分)");
    process.exit(1);
  }

  const missing = [];
  if (!FREINS_EMAIL) missing.push("FREINS_EMAIL");
  if (!FREINS_PASSWORD) missing.push("FREINS_PASSWORD");
  if (missing.length) {
    log("FATAL", "env_missing", { missing });
    process.exit(1);
  }

  const runId = `recheck_${new Date().toISOString().replace(/[:.]/g, "").substring(0, 15)}`;
  const startTime = Date.now();
  log("INFO", "start", { intervalSec, maxRounds: MAX_RECHECK_ROUNDS, runId, headless: HEADLESS });

  // ===== 再確認キュー取得: 各 object_id の最新 judgment が vanished の物件 =====
  const dbClient = await pool.connect();
  let initialQueue;
  try {
    const { rows } = await dbClient.query(`
      SELECT latest.object_id, latest.freins_id, latest.ams_status
      FROM (
        SELECT DISTINCT ON (sc.object_id)
          sc.object_id, p.freins_id, sc.ams_status, sc.judgment
        FROM status_checks sc
        JOIN properties p ON p.object_id = sc.object_id
        WHERE p.media = 'freins'
          AND p.freins_id IS NOT NULL
          AND p.status = 'active'
        ORDER BY sc.object_id, sc.checked_at DESC
      ) latest
      WHERE latest.judgment = 'vanished'
      ORDER BY latest.object_id
    `);
    initialQueue = rows;
  } finally {
    dbClient.release();
  }

  log("INFO", "queue_loaded", { count: initialQueue.length });
  if (initialQueue.length === 0) {
    log("INFO", "no_targets", {});
    console.log("\n再確認キューは空です（vanished の物件なし）。\n");
    await pool.end();
    return;
  }

  console.log(`\n再確認キュー: ${initialQueue.length} 件`);
  for (const p of initialQueue) {
    console.log(`  object_id=${p.object_id}  freins_id=${p.freins_id}  ams_status=${p.ams_status}`);
  }
  console.log(`\n間隔: ${intervalSec}秒 × ${MAX_RECHECK_ROUNDS}ラウンド`);
  console.log(`推定所要時間: 約 ${Math.round((intervalSec * MAX_RECHECK_ROUNDS + initialQueue.length * 5 * MAX_RECHECK_ROUNDS) / 60)} 分\n`);

  // ===== Playwright 起動・ログイン =====
  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage();

  // 未確定物件の追跡: Map<object_id, { object_id, freins_id, ams_status, rechecksDone }>
  const pending = new Map(initialQueue.map(p => [p.object_id, { ...p, rechecksDone: 0 }]));

  try {
    await loginFreins(page);

    for (let round = 1; round <= MAX_RECHECK_ROUNDS; round++) {
      if (pending.size === 0) {
        log("INFO", "all_resolved_early", { round });
        break;
      }

      // ラウンド前に間隔待機（本番30分・テスト2〜3分）
      log("INFO", "interval_wait_start", { round, intervalSec, pendingCount: pending.size });
      await sleep(intervalSec * 1000);
      log("INFO", "interval_wait_done", { round });

      const roundItems = [...pending.values()];
      log("INFO", "round_start", { round, count: roundItems.length });
      let consecutiveErrors = 0;

      for (let i = 0; i < roundItems.length; i++) {
        const prop = roundItems[i];
        log("INFO", "recheck_item", {
          round, i: i + 1, total: roundItems.length,
          objectId: prop.object_id, freinsId: prop.freins_id,
        });

        let fetchResult = await fetchFreinsStatus(page, prop.freins_id);

        // セッション切れ → 再ログイン後リトライ（1回まで）
        if (fetchResult.judgment === "error" && fetchResult.note?.includes("セッション切れ")) {
          log("WARN", "session_relogin", { freinsId: prop.freins_id });
          await loginFreins(page);
          fetchResult = await fetchFreinsStatus(page, prop.freins_id);
        }

        prop.rechecksDone++;
        const isFinalRound = round === MAX_RECHECK_ROUNDS;

        // 「ページ復活」= error でも 404(vanished_suspected) でもない = detail が読めた
        const pageRecovered =
          fetchResult.judgment !== "error" &&
          fetchResult.judgment !== "vanished_suspected";

        let dbJudgment, mediaStatus, note;

        if (pageRecovered) {
          // ページ復活 → その時点のステータスで突合確定
          const { judgment: j, desc } = computeDetailJudgment(prop.ams_status, fetchResult);
          dbJudgment = j;
          mediaStatus = fetchResult.mediaStatus;
          note = `再確認${round}回目/3: ページ復活 → ${desc}`;
          pending.delete(prop.object_id);
          log("INFO", "page_recovered", { round, objectId: prop.object_id, judgment: dbJudgment });
        } else if (fetchResult.judgment === "error") {
          // エラー（タイムアウト・ネットワーク等）
          dbJudgment = "error";
          mediaStatus = null;
          note = `再確認${round}回目/3: エラー → ${fetchResult.note}`;
          consecutiveErrors++;
          log("WARN", "recheck_error", { round, objectId: prop.object_id, note: fetchResult.note });
        } else {
          // 404継続
          mediaStatus = "vanished";
          const totalAttempts = 1 + prop.rechecksDone; // 1巡目 + 今回まで
          if (isFinalRound) {
            dbJudgment = "vanished";
            note = `再確認${round}回目/3: 404継続 → vanished確定（計${totalAttempts}回404）`;
            pending.delete(prop.object_id);
            log("INFO", "vanished_confirmed", { objectId: prop.object_id, totalAttempts });
          } else {
            dbJudgment = "vanished";
            note = `再確認${round}回目/3: 404継続（計${totalAttempts}回404）`;
            log("INFO", "still_vanished", { round, objectId: prop.object_id, totalAttempts });
          }
        }

        // status_checks に append-only で記録
        const writeClient = await pool.connect();
        try {
          await writeClient.query("BEGIN");
          await insertStatusCheck(writeClient, {
            objectId: prop.object_id,
            amsStatus: prop.ams_status,
            mediaStatus,
            judgment: dbJudgment,
            note,
            runId,
          });
          await writeClient.query("COMMIT");
        } catch (err) {
          await writeClient.query("ROLLBACK");
          throw err;
        } finally {
          writeClient.release();
        }

        // 連続エラーカウント（404 はエラーではないのでリセット）
        if (fetchResult.judgment !== "error") consecutiveErrors = 0;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw new Error(`連続エラーが ${MAX_CONSECUTIVE_ERRORS} 件。異常とみなして停止します。`);
        }

        // 1件ごとの待機（同一ラウンド内の最後の件は不要）
        if (i < roundItems.length - 1) {
          const waitMs = WAIT_MIN_MS + Math.random() * WAIT_RANGE_MS;
          log("INFO", "rate_limit_wait", { ms: Math.round(waitMs) });
          await page.waitForTimeout(waitMs);
        }
      }

      log("INFO", "round_done", { round, remaining: pending.size });
    }
  } finally {
    await browser.close();
    log("INFO", "browser_closed", { elapsed_s: ((Date.now() - startTime) / 1000).toFixed(1) });
  }

  // ===== 結果サマリー =====
  const summaryClient = await pool.connect();
  try {
    // 今回の run_id のレコード内訳
    const { rows: breakdown } = await summaryClient.query(
      `SELECT judgment, count(*)::int AS cnt
         FROM status_checks
        WHERE run_id = $1
        GROUP BY judgment
        ORDER BY judgment`,
      [runId]
    );

    // 各物件の「最新」レコード（今回の run_id 内で最後に書いたもの）
    const { rows: finals } = await summaryClient.query(
      `SELECT DISTINCT ON (sc.object_id)
          sc.object_id, p.freins_id, sc.ams_status, sc.media_status, sc.judgment, sc.note
       FROM status_checks sc
       JOIN properties p ON p.object_id = sc.object_id
       WHERE sc.run_id = $1
       ORDER BY sc.object_id, sc.checked_at DESC`,
      [runId]
    );

    // 今回の run_id の全ラウンド履歴（物件ごとの経緯確認用）
    const { rows: history } = await summaryClient.query(
      `SELECT sc.object_id, sc.checked_at, sc.judgment, sc.note
         FROM status_checks sc
        WHERE sc.run_id = $1
        ORDER BY sc.object_id, sc.checked_at`,
      [runId]
    );

    console.log("\n========== 404再確認 結果サマリー ==========");
    console.log(`run_id      : ${runId}`);
    console.log(`対象件数    : ${initialQueue.length} 件`);
    console.log(`間隔        : ${intervalSec} 秒`);
    console.log(`所要時間    : ${((Date.now() - startTime) / 1000).toFixed(1)} 秒`);
    console.log("\n--- judgment 内訳（再確認レコード合計） ---");
    for (const r of breakdown) {
      console.log(`  ${r.judgment.padEnd(18)}: ${r.cnt} 件`);
    }

    console.log("\n--- 物件ごとの最終確定結果 ---");
    for (const f of finals) {
      console.log(`  [${f.judgment}] object_id=${f.object_id}  freins_id=${f.freins_id}`);
      console.log(`          AMS: ${f.ams_status} / ふれんず: ${f.media_status ?? "(なし)"}`);
      console.log(`          note: ${f.note}`);
    }

    if (history.length > 0) {
      console.log("\n--- 全ラウンド履歴（append-only 確認） ---");
      let lastObjectId = null;
      for (const h of history) {
        if (h.object_id !== lastObjectId) {
          console.log(`  object_id=${h.object_id}`);
          lastObjectId = h.object_id;
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
