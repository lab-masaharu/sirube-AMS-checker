// ============================================================
// sirube-ams-checker / ふれんずアダプタ テスト版 fetch-freins.js
// system_code: sys_ops_ams_checker
//
// 使用方法: node fetch-freins.js <freins_id>
// 例:       node fetch-freins.js 000002493897
//
// 1件の詳細ページを開き、取引状況原文・標準ステータスを出力する。
// DBには書かない。テスト・検証専用。
//
// 判定ロジック（CLAUDE.md §11 準拠）:
//   body.error-page / 「該当物件情報がありませんでした」 → vanished_suspected
//   body.detail → .info-label[取引状況] の直後 .info-val テキストを取得 → 翻訳
//   auth.f-takken.com へリダイレクト                    → error（セッション切れ）
//   HTTP 403/429                                        → 即停止
//
// 安全方針（CLAUDE.md §10/11 準拠）:
//   許可クリック: SSOログイン送信ボタンのみ
//   禁止クリック: 登録/保存/削除/申込/お問い合わせ等（詳細は BANNED_SELECTOR_PATTERNS）
//   Note: "submit" は禁止語から除外（button[type="submit"] がSSO送信に必要なため）。
//         代わりに "申込" "apply" 等をより具体的に禁止する。
// ============================================================

import { chromium } from "playwright";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

dotenv.config();

const SYSTEM_CODE = "sys_ops_ams_checker";
const FREINS_BASE = "https://b2b.f-takken.com";
const FREINS_EMAIL = process.env.FREINS_EMAIL;
const FREINS_PASSWORD = process.env.FREINS_PASSWORD;
const HEADLESS = (process.env.HEADLESS || "false").toLowerCase() === "true";

// ============================================================
// クリック・ホワイトリスト・ガード（CLAUDE.md §10/11 準拠）
// ふれんず: SSOログイン送信のみ許可。詳細ページは page.goto() で閲覧。
//
// "submit" は禁止語リストから意図的に除外（§11 末尾の注意事項を参照）。
// ============================================================

const BANNED_SELECTOR_PATTERNS = [
  "登録", "保存", "削除", "複製", "申込", "お問い合わせ",
  "regist", "save", "delete", "btnSave", "apply", "inquiry", "contact",
];

// 許可クリックセレクタ（auth.f-takken.com のSSOログイン送信のみ）
const ALLOWED_CLICK_SELECTORS = [
  'button[type="submit"]',         // SSOログイン送信（ボタン型）
  'input[type="submit"]',          // SSOログイン送信（input型）
  'button:has-text("ログイン")',   // SSOログインボタン（テキスト指定）
  'button:has-text("サインイン")', // SSOログインボタン（別表記）
  'button:has-text("Sign in")',    // SSOログインボタン（英語）
];

function log(level, action, metadata = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level, systemCode: SYSTEM_CODE, service: "fetch-freins", action, metadata,
  }));
}

// クリック安全ガード: 禁止語チェック（二重ガード）→ ホワイトリストチェックの順で判定
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

// ============================================================
// 取引状況原文 → 標準ステータス変換（CLAUDE.md §11 翻訳テーブル）
// ============================================================
export function translateStatus(rawStatus) {
  if (!rawStatus) return "unknown";
  const s = rawStatus.trim();
  if (s === "公開中") return "open";
  if (s === "商談中" || s === "ただいま商談中です") return "negotiating";
  if (s.includes("書面による購入申込")) return "negotiating";
  // 上記以外は未知表現: unknown を返し原文を呼び出し元で保持する
  return "unknown";
}

// ============================================================
// ふれんず SSO ログイン（auth.f-takken.com）
// ============================================================
export async function loginFreins(page) {
  log("INFO", "login_navigate", { url: FREINS_BASE });
  await page.goto(FREINS_BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  const currentUrl = page.url();
  if (!currentUrl.includes("auth.f-takken.com")) {
    log("INFO", "login_already_authenticated", { url: currentUrl });
    return;
  }

  log("INFO", "login_sso_redirect", { authUrl: currentUrl });

  // 入力フィールドを探す（複数のセレクタパターンを試みる）
  // input[name="username"] はふれんずで確認済み。他はフォールバック。
  const emailSelectors = [
    'input[name="username"]',
    'input[type="email"]', 'input[name="email"]',
    'input[name="login"]',
    '#email', '#loginId', '#userId',
  ];
  const passwordSelectors = [
    'input[type="password"]', 'input[name="password"]',
    '#password', '#passwd',
  ];

  let emailField = null;
  for (const sel of emailSelectors) {
    emailField = await page.$(sel);
    if (emailField) { log("INFO", "email_field_found", { selector: sel }); break; }
  }

  let passwordField = null;
  for (const sel of passwordSelectors) {
    passwordField = await page.$(sel);
    if (passwordField) { log("INFO", "password_field_found", { selector: sel }); break; }
  }

  if (!emailField || !passwordField) {
    throw new Error(
      "ふれんずSSOログインフォームの入力欄が見つかりません。" +
      `email: ${!!emailField}, password: ${!!passwordField}. ` +
      "HEADLESS=false で画面を確認してください。"
    );
  }

  await emailField.fill(FREINS_EMAIL);
  await passwordField.fill(FREINS_PASSWORD);
  log("INFO", "login_credentials_filled", {});

  // submit ボタンを探してホワイトリスト経由でクリック
  let submitSelector = null;
  const submitCandidates = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("ログイン")',
    'button:has-text("サインイン")',
    'button:has-text("Sign in")',
  ];
  for (const sel of submitCandidates) {
    const el = await page.$(sel);
    if (el) { submitSelector = sel; log("INFO", "submit_button_found", { selector: sel }); break; }
  }

  if (!submitSelector) {
    throw new Error(
      "SSOログインの送信ボタンが見つかりません。HEADLESS=false で画面を確認してください。"
    );
  }

  await safeClick(page, submitSelector, "ふれんずSSO ログイン送信");
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const afterUrl = page.url();
  if (afterUrl.includes("auth.f-takken.com")) {
    throw new Error(
      "ログイン後も auth.f-takken.com に留まっています。" +
      "FREINS_EMAIL / FREINS_PASSWORD が正しいか確認してください。"
    );
  }

  log("INFO", "login_done", { url: afterUrl });
}

// ============================================================
// 取引状況テキストの抽出
// ふれんず詳細ページ: .info-label「取引状況」の直後の .info-val を取得
// ============================================================
async function extractTradeStatus(page) {
  return await page.evaluate(() => {
    // パターン1: .info-label / .info-val の組み合わせ
    const labels = Array.from(document.querySelectorAll(".info-label"));
    for (const label of labels) {
      if (label.textContent.trim().includes("取引状況")) {
        // 同一親要素内の .info-val を探す
        const parent = label.parentElement;
        if (parent) {
          const val = parent.querySelector(".info-val");
          if (val) return val.textContent.trim();
        }
        // 直後の兄弟要素を試みる
        const next = label.nextElementSibling;
        if (next) return next.textContent.trim();
      }
    }

    // パターン2: th/dt などのラベル要素 → 隣接する td/dd
    const headerCells = Array.from(document.querySelectorAll("th, dt"));
    for (const cell of headerCells) {
      if (cell.textContent.trim().includes("取引状況")) {
        const next = cell.nextElementSibling;
        if (next) return next.textContent.trim();
        const row = cell.closest("tr");
        if (row) {
          const td = row.querySelector("td");
          if (td) return td.textContent.trim();
        }
      }
    }

    return null;
  });
}

// ============================================================
// 1件のふれんず詳細ページを取得・判定
// ============================================================
export async function fetchFreinsStatus(page, freinsId) {
  const url = `${FREINS_BASE}/properties/detail?id=${freinsId}`;
  log("INFO", "fetch_start", { freinsId, url });

  let response;
  try {
    response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (err) {
    log("WARN", "fetch_error", { freinsId, message: err.message });
    return {
      freinsId, url, judgment: "error",
      rawStatus: null, mediaStatus: null,
      note: `取得失敗: ${err.message}`,
    };
  }

  const httpStatus = response?.status() ?? 0;
  const finalUrl = page.url();

  // セッション切れ（auth.f-takken.com へリダイレクト）
  if (finalUrl.includes("auth.f-takken.com")) {
    log("WARN", "session_expired", { freinsId, finalUrl });
    return {
      freinsId, url, judgment: "error",
      rawStatus: null, mediaStatus: null,
      note: "セッション切れ - auth.f-takken.com へリダイレクト",
    };
  }

  // 403/429: アクセス拒否 → 即停止
  if (httpStatus === 403 || httpStatus === 429) {
    log("ERROR", "access_denied_stop", { freinsId, httpStatus });
    throw new Error(`[STOP] HTTP ${httpStatus} - アクセス拒否。全体を即座に停止します。`);
  }

  await page.waitForTimeout(500);

  const bodyClass = await page.$eval("body", (el) => el.className).catch(() => "");
  const bodyText = await page.$eval("body", (el) => el.innerText).catch(() => "");

  log("INFO", "page_loaded", {
    freinsId, httpStatus,
    bodyClass: bodyClass.substring(0, 120),
    finalUrl,
  });

  // エラーページ（物件消失・404）
  if (
    bodyClass.includes("error-page") ||
    bodyText.includes("該当物件情報がありませんでした") ||
    httpStatus === 404
  ) {
    log("INFO", "page_vanished_suspected", { freinsId, httpStatus });
    return {
      freinsId, url, judgment: "vanished_suspected",
      rawStatus: null, mediaStatus: "vanished",
      note: `ふれんず 消失疑い (HTTP ${httpStatus}, bodyClass: "${bodyClass.substring(0, 60)}")`,
    };
  }

  // 詳細ページ（body.detail）
  if (bodyClass.includes("detail")) {
    const rawStatus = await extractTradeStatus(page);
    log("INFO", "raw_status_extracted", { freinsId, rawStatus });

    if (rawStatus === null) {
      return {
        freinsId, url, judgment: "error",
        rawStatus: null, mediaStatus: "unknown",
        note: "取引状況ラベルが見つかりませんでした（ページ構造を要確認）",
      };
    }

    const mediaStatus = translateStatus(rawStatus);
    return {
      freinsId, url, judgment: mediaStatus,
      rawStatus, mediaStatus,
      note: `取引状況原文: 「${rawStatus}」`,
    };
  }

  // 想定外のページ構造
  log("WARN", "unknown_page_structure", {
    freinsId, httpStatus,
    bodyClass: bodyClass.substring(0, 120),
  });
  return {
    freinsId, url, judgment: "error",
    rawStatus: null, mediaStatus: null,
    note: `不明なページ構造 (HTTP ${httpStatus}, bodyClass: "${bodyClass.substring(0, 80)}")`,
  };
}

// ============================================================
// main
// ============================================================
async function main() {
  const freinsId = process.argv[2];
  if (!freinsId) {
    console.error("使用方法: node fetch-freins.js <freins_id>");
    console.error("例:       node fetch-freins.js 000002493897");
    process.exit(1);
  }

  const missing = [];
  if (!FREINS_EMAIL) missing.push("FREINS_EMAIL");
  if (!FREINS_PASSWORD) missing.push("FREINS_PASSWORD");
  if (missing.length) {
    log("FATAL", "env_missing", { missing });
    console.error(`[エラー] .env に ${missing.join(", ")} が未設定です。`);
    process.exit(1);
  }

  log("INFO", "start", { freinsId, headless: HEADLESS });

  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage();

  try {
    await loginFreins(page);
    const result = await fetchFreinsStatus(page, freinsId);

    log("INFO", "result", result);

    console.log("\n========== ふれんずアダプタ 判定結果 ==========");
    console.log(`freins_id    : ${result.freinsId}`);
    console.log(`取引状況原文 : ${result.rawStatus ?? "(なし)"}`);
    console.log(`標準ステータス: ${result.mediaStatus ?? "(なし)"}`);
    console.log(`judgment     : ${result.judgment}`);
    console.log(`note         : ${result.note ?? "(なし)"}`);
    console.log("================================================\n");
  } catch (err) {
    log("ERROR", "fetch_failed", { message: err.message });
    console.error("\n[エラー]", err.message);
    console.error("HEADLESS=false で画面を確認してください。\n");
    throw err;
  } finally {
    await browser.close();
    log("INFO", "end", {});
  }
}

// このファイルを直接実行した場合のみ main() を呼ぶ（importされた場合は呼ばない）
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => process.exit(1));
}
