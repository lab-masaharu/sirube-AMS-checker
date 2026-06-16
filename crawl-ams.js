// ============================================================
// sirube-ams-checker / AMS巡回・媒体仕分け 取得スクリプト v0.4
// system_code: sys_ops_ams_checker
//
// 確定した操作フロー（診断で実証済み）:
//   1. ログイン（#ipt_user_email_1 / #ipt_user_password / #btnLogin）
//   2. 「検索画面」リンクをクリック → colorbox iframe(search.html) が開く
//   3. iframe内でステータスチェックボックスを明示設定（4つ全て）
//   4. iframe内の a.btnExec(リストで表示) をクリック
//   5. 親ページに結果リスト（#hidden_object_count, tr[data-href] 30件/頁）が出る
//   6. getObjectList(page) で 1→最終ページまで巡回し object_id と媒体URLを抽出
//
// v0.4 変更点:
//   - クリック・ホワイトリスト・ガード（safeClick / ALLOWED_CLICK_SELECTORS）を実装。
//     許可リスト外のセレクタは throw して即停止。禁止語の二重チェックあり。
//   - ページめくりを getObjectList 固定名のみ許可し、フォールバック evaluate を削除。
//
// v0.3 変更点:
//   - 2パス巡回（公開のみ → 商談中のみ）に変更。
//   - 各パスで4チェックボックスを明示的に設定し、ログで状態検証。
//   - 各物件行に amsStatus（公開/商談中）を付与。
//   - 公開パスで760件超の場合は「商談中が外れていない」と判断して停止。
//
// 本番システム安全方針（CLAUDE.md §10 準拠）:
//   許可: ログイン・検索条件指定・検索実行・一覧/詳細閲覧・ページめくり
//   禁止: データ登録/更新/削除、保存/削除/登録ボタン、状態変更操作
//
// 認証情報は .env から読み込む（ハードコード禁止）。
// このスクリプトは取得・仕分けのみ。突合・DB・書き戻しはしない。
// ============================================================

import { chromium } from "playwright";
import dotenv from "dotenv";
import fs from "node:fs";

dotenv.config();

const SYSTEM_CODE = "sys_ops_ams_checker";
const AMS_LOGIN_URL = process.env.AMS_LOGIN_URL || "https://agent-master.jp/";
const AMS_EMAIL = process.env.AMS_EMAIL;
const AMS_PASSWORD = process.env.AMS_PASSWORD;
const HEADLESS = (process.env.HEADLESS || "false").toLowerCase() === "true";
const PAGE_WAIT_MS = parseInt(process.env.PAGE_WAIT_MS || "1500", 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || "30", 10);
const PAGE_SIZE = 30;

// 公開パスでこの件数を超えたら「商談中チェックが外れていない」とみなして停止
// 実測: 公開=736, 商談中=40, 合計=776。736+余裕で760を閾値とする。
const PUBLIC_COUNT_SANITY_LIMIT = 760;

// ============================================================
// クリック・ホワイトリスト・ガード（CLAUDE.md §10 準拠）
// AMS/ふれんずは本番稼働中。クリック操作はこのリストに限定する。
// ============================================================

// 禁止語パターン: これらを含むセレクタはホワイトリスト判定より先に即拒否（二重ガード）
const BANNED_SELECTOR_PATTERNS = [
  "登録", "保存", "削除", "複製",
  "regist", "save", "delete", "submit", "btnSave",
];

// 許可クリックセレクタ一覧（ここに列挙したもの以外はすべてブロック）
const ALLOWED_CLICK_SELECTORS = [
  "#btnLogin",                  // ログインボタン（閲覧開始に必要）
  'a:has-text("検索画面")',      // 検索画面を開く（閲覧のみ）
  "#obj_status1_chk",           // 検索条件指定: 公開フィルタ
  "#obj_status2_chk",           // 検索条件指定: 商談中フィルタ
  "#obj_status3_chk",           // 検索条件指定: 成約済フィルタ
  "#obj_status4_chk",           // 検索条件指定: 売止めフィルタ
  "a.btnExec",                  // 検索実行（リストで表示）
];

// ============================================================

function log(level, action, metadata = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level, systemCode: SYSTEM_CODE, service: "crawl-ams", action, metadata,
  }));
}

// クリック安全ガード: 禁止語チェック（二重ガード）→ ホワイトリストチェックの順で判定
// 許可リスト外のセレクタは即 throw して停止する
function safeClick(target, selector, reason) {
  for (const banned of BANNED_SELECTOR_PATTERNS) {
    if (selector.includes(banned)) {
      log("ERROR", "click_blocked_banned_keyword", { selector, banned, reason });
      throw new Error(
        `[SAFETY] 禁止語を含むセレクタのクリックを拒否: "${selector}" (禁止語: "${banned}") / ${reason}`
      );
    }
  }
  if (!ALLOWED_CLICK_SELECTORS.includes(selector)) {
    log("ERROR", "click_blocked_not_whitelisted", { selector, allowed: ALLOWED_CLICK_SELECTORS, reason });
    throw new Error(
      `[SAFETY] ホワイトリスト外のセレクタのクリックを拒否: "${selector}" / ${reason}`
    );
  }
  log("INFO", "safe_click", { selector, reason });
  return target.click(selector);
}

function detectMedia(url) {
  if (!url) return "none";
  if (url.includes("b2b.f-takken.com")) return "freins";
  if (url.includes("suumo.jp")) return "suumo";
  if (url.includes("athome.co.jp")) return "athome";
  if (url.includes("homes.co.jp")) return "homes";
  return "other";
}

function extractFreinsId(url) {
  if (!url) return null;
  const m = url.match(/[?&]id=([0-9A-Za-z]+)/);
  return m ? m[1] : null;
}

function assertEnv() {
  const missing = [];
  if (!AMS_EMAIL) missing.push("AMS_EMAIL");
  if (!AMS_PASSWORD) missing.push("AMS_PASSWORD");
  if (missing.length) {
    log("FATAL", "env_missing", { missing });
    console.error(`\n[エラー] .env に ${missing.join(", ")} が未設定です。\n`);
    process.exit(1);
  }
}

async function extractRows(page) {
  const rows = await page.$$eval("tr[data-href]", (trs) => {
    return trs.map((tr) => {
      const objectId = tr.getAttribute("data-href");
      const anchors = Array.from(tr.querySelectorAll("a[href]"));
      let mediaUrl = null;
      for (const a of anchors) {
        const href = a.getAttribute("href") || "";
        if (href.startsWith("http") && !href.includes("object_detail") && !href.includes("/cma/")) {
          mediaUrl = href;
          break;
        }
      }
      return { objectId, mediaUrl };
    });
  });
  for (const r of rows) {
    r.media = detectMedia(r.mediaUrl);
    r.freinsId = r.media === "freins" ? extractFreinsId(r.mediaUrl) : null;
  }
  return rows;
}

// 全4チェックボックスの定義（ID順）
const STATUS_BOXES = [
  { id: "#obj_status1_chk", label: "公開" },
  { id: "#obj_status2_chk", label: "商談中" },
  { id: "#obj_status3_chk", label: "成約済" },
  { id: "#obj_status4_chk", label: "売止め" },
];

// 4つのチェックボックスを明示的に設定し、設定後の実状態をログ出力する
async function setStatusCheckboxes(frame, targetId) {
  for (const { id } of STATUS_BOXES) {
    const shouldCheck = id === targetId;
    const current = await frame.$eval(id, (el) => el.checked).catch(() => null);
    if (current === null) {
      log("WARN", "checkbox_not_found", { id });
      continue;
    }
    if (current !== shouldCheck) {
      await safeClick(frame, id, "検索条件チェックボックス設定");
    }
  }
  // 設定後の実際の状態を読み取って検証ログを出力
  const states = {};
  for (const { id, label } of STATUS_BOXES) {
    states[label] = await frame.$eval(id, (el) => el.checked).catch(() => "?");
  }
  log("INFO", "checkbox_state_verified", states);
  return states;
}

// 1ステータス分の巡回（検索画面オープン〜全ページ取得まで）
async function crawlByStatus(page, targetCheckboxId, amsStatusLabel) {
  log("INFO", "pass_start", { pass: amsStatusLabel });

  // 検索画面を開く（パス間でも再クリックして iframe をリセット）
  await safeClick(page, 'a:has-text("検索画面")', "検索画面を開く");
  await page.waitForTimeout(3000);

  const frame = page.frames().find((f) => f.url().includes("search.html"));
  if (!frame) throw new Error("検索iframe(search.html)が見つかりません");
  log("INFO", "search_frame_ready", { pass: amsStatusLabel, url: frame.url() });

  // 4チェックボックスを明示設定（目的のステータス以外はすべてOFF）
  const states = await setStatusCheckboxes(frame, targetCheckboxId);
  const targetEntry = STATUS_BOXES.find((s) => s.id === targetCheckboxId);
  if (!states[targetEntry.label]) {
    throw new Error(`チェックボックス設定失敗: ${targetEntry.label} が ON になりませんでした`);
  }

  // クリック前に先頭行IDを記録（前パスの結果が残っていても誤検知しないため）
  const prevFirstRow = await page.$eval("tr[data-href]", (tr) => tr.getAttribute("data-href")).catch(() => null);

  // 検索実行（リストで表示）
  await safeClick(frame, "a.btnExec", "検索実行（リストで表示）");
  log("INFO", "list_show_clicked", { pass: amsStatusLabel });

  if (prevFirstRow !== null) {
    // 前パスの結果が画面に残っている場合: まず先頭行が変わるか消えるまで待つ
    await page.waitForFunction((prev) => {
      const tr = document.querySelector("tr[data-href]");
      return !tr || tr.getAttribute("data-href") !== prev;
    }, prevFirstRow, { timeout: 30000 }).catch(() => {
      log("WARN", "results_transition_timeout", { pass: amsStatusLabel });
    });
    // その後、新しい結果が揃うまで待つ（#hidden_object_count に値が入るまで）
    await page.waitForFunction(() => {
      const c = document.querySelector("#hidden_object_count");
      return c && c.value && parseInt(c.value, 10) > 0;
    }, { timeout: 30000 }).catch(() => {
      log("WARN", "list_wait_timeout", { pass: amsStatusLabel });
    });
  } else {
    // 初回パス（画面に先行結果なし）: 何かコンテンツが出るまで待つ
    await page.waitForFunction(() => {
      const c = document.querySelector("#hidden_object_count");
      const tr = document.querySelector("tr[data-href]");
      return (c && c.value && parseInt(c.value, 10) > 0) || !!tr;
    }, { timeout: 30000 }).catch(() => {
      log("WARN", "list_wait_timeout", { pass: amsStatusLabel });
    });
  }
  await page.waitForTimeout(2000);

  const totalCount = await page.$eval("#hidden_object_count", (el) => el.value).catch(() => null);
  const totalNum = totalCount ? parseInt(totalCount, 10) : null;
  log("INFO", "total_count", { pass: amsStatusLabel, totalCount });

  // 補強2: 公開パスで760件超 = 商談中チェックが外れていない疑い → 即停止
  if (amsStatusLabel === "公開" && totalNum !== null && totalNum > PUBLIC_COUNT_SANITY_LIMIT) {
    log("ERROR", "sanity_check_failed", {
      pass: amsStatusLabel,
      totalCount: totalNum,
      limit: PUBLIC_COUNT_SANITY_LIMIT,
      message: "公開パスの件数が上限超過。商談中チェックが外れていない可能性。処理停止。",
    });
    throw new Error(
      `[検証失敗] 公開パスの件数が ${totalNum} 件（上限 ${PUBLIC_COUNT_SANITY_LIMIT}）。` +
      `商談中チェックが外れていない可能性があります。HEADLESS=false で確認してください。`
    );
  }

  // ページめくり安全確認: getObjectList が存在しない場合は安全に停止
  const hasGetObjectList = await page.evaluate(() => typeof getObjectList === "function").catch(() => false);
  if (!hasGetObjectList) {
    log("ERROR", "pagination_unsafe", {
      pass: amsStatusLabel,
      message: "getObjectList が見つかりません。安全なページめくり手段がないため停止します。",
    });
    throw new Error(
      `[SAFETY] getObjectList が見つかりません。安全なページめくり手段がないため停止します。（pass: ${amsStatusLabel}）`
    );
  }

  const passRows = [];
  let pageNum = 1;
  const maxByCount = totalNum ? Math.ceil(totalNum / PAGE_SIZE) : MAX_PAGES;
  const pageLimit = Math.min(MAX_PAGES, maxByCount);

  while (pageNum <= pageLimit) {
    if (pageNum > 1) {
      const beforeId = await page.$eval("tr[data-href]", (tr) => tr.getAttribute("data-href")).catch(() => null);
      // getObjectList 固定名のみ許可（他の関数を evaluate で呼ぶことは禁止）
      await page.evaluate((p) => { getObjectList(String(p)); }, pageNum);
      await page.waitForFunction((prev) => {
        const tr = document.querySelector("tr[data-href]");
        return tr && tr.getAttribute("data-href") !== prev;
      }, beforeId, { timeout: 15000 }).catch(() => {
        log("WARN", "page_change_not_detected", { pass: amsStatusLabel, pageNum });
      });
      await page.waitForTimeout(500);
    }

    const rows = await extractRows(page);
    for (const r of rows) r.amsStatus = amsStatusLabel;
    passRows.push(...rows);
    log("INFO", "page_done", { pass: amsStatusLabel, pageNum, rowsThisPage: rows.length, totalSoFar: passRows.length });

    if (rows.length === 0) { log("INFO", "empty_page_stop", { pass: amsStatusLabel, pageNum }); break; }
    if (totalNum && passRows.length >= totalNum) { log("INFO", "reached_total", { pass: amsStatusLabel, totalNum }); break; }

    pageNum += 1;
    await page.waitForTimeout(PAGE_WAIT_MS);
  }

  log("INFO", "pass_done", { pass: amsStatusLabel, rows: passRows.length, expectedFromAms: totalNum });
  return { rows: passRows, totalNum };
}

async function main() {
  assertEnv();
  log("INFO", "start", { headless: HEADLESS, maxPages: MAX_PAGES });

  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage();

  try {
    // ===== 1. ログイン =====
    log("INFO", "login_open", { url: AMS_LOGIN_URL });
    await page.goto(AMS_LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.fill("#ipt_user_email_1", AMS_EMAIL);
    await page.fill("#ipt_user_password", AMS_PASSWORD);
    await safeClick(page, "#btnLogin", "ログイン認証");
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    log("INFO", "login_done", { url: page.url() });

    // ===== 2. 公開パス（1パス目） =====
    const pass1 = await crawlByStatus(page, "#obj_status1_chk", "公開");

    // ===== 3. 商談中パス（2パス目） =====
    const pass2 = await crawlByStatus(page, "#obj_status2_chk", "商談中");

    // ===== 4. 統合・集計 =====
    const allRows = [...pass1.rows, ...pass2.rows];
    const statusBreakdown = {
      "公開": pass1.rows.length,
      "商談中": pass2.rows.length,
    };

    const mediaBreakdown = { freins: 0, suumo: 0, athome: 0, homes: 0, other: 0, none: 0 };
    for (const r of allRows) mediaBreakdown[r.media] = (mediaBreakdown[r.media] || 0) + 1;

    const ids = allRows.map((r) => r.objectId);
    const uniqueIds = new Set(ids);

    log("INFO", "summary", {
      totalRows: allRows.length,
      uniqueObjectIds: uniqueIds.size,
      duplicates: ids.length - uniqueIds.size,
      statusBreakdown,
      mediaBreakdown,
    });

    const output = {
      systemCode: SYSTEM_CODE,
      crawledAt: new Date().toISOString(),
      totalRows: allRows.length,
      statusBreakdown,
      mediaBreakdown,
      rows: allRows,
    };
    fs.writeFileSync("results.json", JSON.stringify(output, null, 2), "utf-8");
    log("INFO", "saved", { file: "results.json" });

    console.log("\n========== 巡回結果サマリー ==========");
    console.log(`取得した物件行数  : ${allRows.length}`);
    console.log(`ユニークobject_id : ${uniqueIds.size}（重複 ${ids.length - uniqueIds.size}）`);
    console.log(`--- ステータス内訳（実測値: 公開736・商談中40）---`);
    console.log(`  公開    : ${statusBreakdown["公開"]} 件`);
    console.log(`  商談中  : ${statusBreakdown["商談中"]} 件`);
    console.log(`--- 媒体内訳 ---`);
    console.log(`  ふれんず(突合対象): ${mediaBreakdown.freins}`);
    console.log(`  SUUMO            : ${mediaBreakdown.suumo}`);
    console.log(`  athome           : ${mediaBreakdown.athome}`);
    console.log(`  HOME'S           : ${mediaBreakdown.homes}`);
    console.log(`  その他リンク      : ${mediaBreakdown.other}`);
    console.log(`  リンクなし(自社等): ${mediaBreakdown.none}`);
    console.log(`\n詳細は results.json を確認してください。`);
    console.log("=====================================\n");
  } catch (err) {
    log("ERROR", "crawl_failed", { message: err.message });
    console.error("\n[エラー]", err.message, "\nHEADLESS=false で画面確認すると原因が分かりやすいです。\n");
    throw err;
  } finally {
    await browser.close();
    log("INFO", "end", {});
  }
}

main().catch(() => process.exit(1));
