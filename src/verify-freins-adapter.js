// ============================================================
// sirube-ams-checker / FreinsAdapter 移植検証スクリプト
// system_code: sys_ops_ams_checker
//
// 使用方法: node src/verify-freins-adapter.js
//
// 状態既知の4物件に対して FreinsAdapter を実行し、
// fetch-freins.js と同じ結果が出ることを確認する。
// DB への書き込みは行わない。
//
// 期待値:
//   000002493897 → rawStatus: 公開中, mediaStatus: open,         judgment: open
//   000002464509 → rawStatus: 商談中 系, mediaStatus: negotiating, judgment: negotiating
//   000002484300 → rawStatus: 書面による購入申込あり系, mediaStatus: negotiating, judgment: negotiating
//   000002488008 → rawStatus: null, mediaStatus: vanished,        judgment: vanished_suspected（404）
// ============================================================

import { chromium } from "playwright";
import dotenv from "dotenv";
import { FreinsAdapter } from "./adapters/FreinsAdapter.js";

dotenv.config();

const HEADLESS = (process.env.HEADLESS || "false").toLowerCase() === "true";
const VERIFY_WAIT_MS = 3000; // 検証用待機（本番より短い）

const TEST_CASES = [
  {
    freinsId: "000002493897",
    description: "公開中の物件",
    expectedMediaStatus: "open",
    expectedJudgment: "open",
  },
  {
    freinsId: "000002464509",
    description: "商談中の物件",
    expectedMediaStatus: "negotiating",
    expectedJudgment: "negotiating",
  },
  {
    freinsId: "000002484300",
    description: "書面による購入申込あり（negotiating）",
    expectedMediaStatus: "negotiating",
    expectedJudgment: "negotiating",
  },
  {
    freinsId: "000002488008",
    description: "消失疑い（404）",
    expectedMediaStatus: "vanished",
    expectedJudgment: "vanished_suspected",
  },
];

function log(level, action, metadata = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level, systemCode: "sys_ops_ams_checker",
    service: "verify-freins-adapter", action, metadata,
  }));
}

async function main() {
  const missing = [];
  if (!process.env.FREINS_EMAIL) missing.push("FREINS_EMAIL");
  if (!process.env.FREINS_PASSWORD) missing.push("FREINS_PASSWORD");
  if (missing.length) {
    console.error(`[エラー] .env に ${missing.join(", ")} が未設定です。`);
    process.exit(1);
  }

  log("INFO", "start", { testCount: TEST_CASES.length, headless: HEADLESS });

  const adapter = new FreinsAdapter();
  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage();

  const results = [];

  try {
    await adapter.login(page);

    for (let i = 0; i < TEST_CASES.length; i++) {
      const tc = TEST_CASES[i];
      log("INFO", "test_start", { i: i + 1, freinsId: tc.freinsId, description: tc.description });

      const result = await adapter.fetchStatus(page, tc.freinsId);

      const mediaStatusOk = result.mediaStatus === tc.expectedMediaStatus;
      const judgmentOk = result.judgment === tc.expectedJudgment;
      const pass = mediaStatusOk && judgmentOk;

      results.push({ ...tc, result, mediaStatusOk, judgmentOk, pass });
      log("INFO", "test_done", {
        freinsId: tc.freinsId, pass,
        rawStatus: result.rawStatus,
        mediaStatus: result.mediaStatus,
        judgment: result.judgment,
      });

      if (i < TEST_CASES.length - 1) {
        await page.waitForTimeout(VERIFY_WAIT_MS);
      }
    }
  } finally {
    await browser.close();
  }

  // ===== 検証結果レポート =====
  console.log("\n========== FreinsAdapter 移植検証レポート ==========");
  for (const r of results) {
    const mark = r.pass ? "✓ PASS" : "✗ FAIL";
    console.log(`\n[${mark}] ${r.freinsId} - ${r.description}`);
    console.log(`  取引状況原文 : ${r.result.rawStatus ?? "(なし)"}`);
    console.log(`  標準ステータス: ${r.result.mediaStatus ?? "(なし)"}  ← 期待値: ${r.expectedMediaStatus}`);
    console.log(`  judgment     : ${r.result.judgment}  ← 期待値: ${r.expectedJudgment}`);
    console.log(`  note         : ${r.result.note ?? "(なし)"}`);
    if (!r.mediaStatusOk) console.log(`  [!] mediaStatus 不一致`);
    if (!r.judgmentOk) console.log(`  [!] judgment 不一致`);
  }

  const passCount = results.filter(r => r.pass).length;
  console.log(`\n結果: ${passCount} / ${results.length} PASS`);
  console.log("====================================================\n");

  if (passCount < results.length) {
    log("ERROR", "verification_failed", { pass: passCount, total: results.length });
    process.exit(1);
  }

  log("INFO", "verification_passed", { pass: passCount, total: results.length });
}

main().catch((err) => {
  log("ERROR", "fatal", { message: err.message });
  console.error("\n[エラー]", err.message, "\n");
  process.exit(1);
});
