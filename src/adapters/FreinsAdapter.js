// ============================================================
// sirube-ams-checker / ふれんずアダプタ
// system_code: sys_ops_ams_checker
//
// fetch-freins.js のロジックを MediaAdapter 継承クラスとして移植。
// ふれんず固有の知識（SSO・セレクタ・翻訳テーブル・404判定）を
// すべてこのクラスに閉じ込める。
//
// 安全方針（CLAUDE.md §10/11 準拠）:
//   許可クリック: SSOログイン送信ボタンのみ
//   禁止クリック: 登録/保存/削除/申込/お問い合わせ等
//   "submit" は禁止語から除外（button[type="submit"] がSSO送信に必要なため）。
// ============================================================

import dotenv from "dotenv";
import { MediaAdapter } from "./MediaAdapter.js";

dotenv.config();

const SYSTEM_CODE = "sys_ops_ams_checker";
const FREINS_BASE = "https://b2b.f-takken.com";

// 禁止セレクタパターン（部分一致）
const BANNED_SELECTOR_PATTERNS = [
  "登録", "保存", "削除", "複製", "申込", "お問い合わせ",
  "regist", "save", "delete", "btnSave", "apply", "inquiry", "contact",
];

// 許可クリックセレクタ（完全一致・auth.f-takken.com のSSOログイン送信のみ）
const ALLOWED_CLICK_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("ログイン")',
  'button:has-text("サインイン")',
  'button:has-text("Sign in")',
];

export class FreinsAdapter extends MediaAdapter {
  constructor() {
    super();
    this._email = process.env.FREINS_EMAIL;
    this._password = process.env.FREINS_PASSWORD;
  }

  get mediaName() {
    return "freins";
  }

  get displayName() {
    return "ふれんず";
  }

  _log(level, action, metadata = {}) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level, systemCode: SYSTEM_CODE, service: "freins-adapter", action, metadata,
    }));
  }

  // クリック安全ガード: 禁止語チェック → ホワイトリストチェックの順で判定
  _safeClick(target, selector, reason) {
    for (const banned of BANNED_SELECTOR_PATTERNS) {
      if (selector.includes(banned)) {
        this._log("ERROR", "click_blocked_banned_keyword", { selector, banned, reason });
        throw new Error(
          `[SAFETY] 禁止語を含むセレクタのクリックを拒否: "${selector}" (禁止語: "${banned}") / ${reason}`
        );
      }
    }
    if (!ALLOWED_CLICK_SELECTORS.includes(selector)) {
      this._log("ERROR", "click_blocked_not_whitelisted", { selector, allowed: ALLOWED_CLICK_SELECTORS, reason });
      throw new Error(
        `[SAFETY] ホワイトリスト外のセレクタのクリックを拒否: "${selector}" / ${reason}`
      );
    }
    this._log("INFO", "safe_click", { selector, reason });
    return target.click(selector);
  }

  // 取引状況テキスト抽出（ふれんず詳細ページ）
  async _extractTradeStatus(page) {
    return await page.evaluate(() => {
      // パターン1: .info-label / .info-val の組み合わせ
      const labels = Array.from(document.querySelectorAll(".info-label"));
      for (const label of labels) {
        if (label.textContent.trim().includes("取引状況")) {
          const parent = label.parentElement;
          if (parent) {
            const val = parent.querySelector(".info-val");
            if (val) return val.textContent.trim();
          }
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

  // 価格原文抽出（ふれんず詳細ページ）
  // 「その他一時金」など .info-val が同じ値を返す別ラベルと混同しないよう、
  // label.textContent が厳密に「価格」を含むものだけを対象にする（取引状況と同じペア構造）。
  async _extractPrice(page) {
    return await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll(".info-label"));
      for (const label of labels) {
        if (label.textContent.trim().includes("価格")) {
          const parent = label.parentElement;
          if (parent) {
            const val = parent.querySelector(".info-val");
            if (val) return val.textContent.trim();
          }
          const next = label.nextElementSibling;
          if (next) return next.textContent.trim();
        }
      }
      return null;
    });
  }

  // 価格原文 → 円単位の整数に正規化（"1億2000万円" のような億・万混在に対応）
  // 数値として解釈できない原文（"応相談" 等）は null を返す。誤った数値を作らない。
  normalizePrice(rawPrice) {
    if (!rawPrice) return null;
    const s = rawPrice.replace(/,/g, "");

    const oku = s.match(/([0-9]+(?:\.[0-9]+)?)億/);
    const man = s.match(/([0-9]+(?:\.[0-9]+)?)万/);

    if (!oku && !man) return null;

    let yen = 0;
    if (oku) yen += parseFloat(oku[1]) * 100000000;
    if (man) yen += parseFloat(man[1]) * 10000;

    return Math.round(yen);
  }

  // 取引状況原文 → 標準ステータス変換（CLAUDE.md §11 翻訳テーブル）
  translateStatus(rawText) {
    if (!rawText) return "unknown";
    const s = rawText.trim();
    if (s === "公開中") return "open";
    if (s === "商談中" || s === "ただいま商談中です") return "negotiating";
    if (s.includes("書面による購入申込")) return "negotiating";
    return "unknown";
  }

  // SSOログイン（auth.f-takken.com）
  async login(page) {
    this._log("INFO", "login_navigate", { url: FREINS_BASE });
    await page.goto(FREINS_BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    if (!currentUrl.includes("auth.f-takken.com")) {
      this._log("INFO", "login_already_authenticated", { url: currentUrl });
      return;
    }

    this._log("INFO", "login_sso_redirect", { authUrl: currentUrl });

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
      if (emailField) { this._log("INFO", "email_field_found", { selector: sel }); break; }
    }

    let passwordField = null;
    for (const sel of passwordSelectors) {
      passwordField = await page.$(sel);
      if (passwordField) { this._log("INFO", "password_field_found", { selector: sel }); break; }
    }

    if (!emailField || !passwordField) {
      throw new Error(
        "ふれんずSSOログインフォームの入力欄が見つかりません。" +
        `email: ${!!emailField}, password: ${!!passwordField}. ` +
        "HEADLESS=false で画面を確認してください。"
      );
    }

    await emailField.fill(this._email);
    await passwordField.fill(this._password);
    this._log("INFO", "login_credentials_filled", {});

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
      if (el) { submitSelector = sel; this._log("INFO", "submit_button_found", { selector: sel }); break; }
    }

    if (!submitSelector) {
      throw new Error(
        "SSOログインの送信ボタンが見つかりません。HEADLESS=false で画面を確認してください。"
      );
    }

    await this._safeClick(page, submitSelector, "ふれんずSSO ログイン送信");
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const afterUrl = page.url();
    if (afterUrl.includes("auth.f-takken.com")) {
      throw new Error(
        "ログイン後も auth.f-takken.com に留まっています。" +
        "FREINS_EMAIL / FREINS_PASSWORD が正しいか確認してください。"
      );
    }

    this._log("INFO", "login_done", { url: afterUrl });
  }

  // 1件のふれんず詳細ページを取得・判定
  async fetchStatus(page, freinsId) {
    const url = `${FREINS_BASE}/properties/detail?id=${freinsId}`;
    this._log("INFO", "fetch_start", { freinsId, url });

    let response;
    try {
      response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (err) {
      this._log("WARN", "fetch_error", { freinsId, message: err.message });
      return {
        freinsId, url, judgment: "error",
        rawStatus: null, mediaStatus: null, rawPrice: null, price: null,
        note: `取得失敗: ${err.message}`,
      };
    }

    const httpStatus = response?.status() ?? 0;
    const finalUrl = page.url();

    // セッション切れ（auth.f-takken.com へリダイレクト）
    if (finalUrl.includes("auth.f-takken.com")) {
      this._log("WARN", "session_expired", { freinsId, finalUrl });
      return {
        freinsId, url, judgment: "error",
        rawStatus: null, mediaStatus: null, rawPrice: null, price: null,
        note: "セッション切れ - auth.f-takken.com へリダイレクト",
      };
    }

    // 403/429: アクセス拒否 → 即停止
    if (httpStatus === 403 || httpStatus === 429) {
      this._log("ERROR", "access_denied_stop", { freinsId, httpStatus });
      throw new Error(`[STOP] HTTP ${httpStatus} - アクセス拒否。全体を即座に停止します。`);
    }

    await page.waitForTimeout(500);

    const bodyClass = await page.$eval("body", (el) => el.className).catch(() => "");
    const bodyText = await page.$eval("body", (el) => el.innerText).catch(() => "");

    this._log("INFO", "page_loaded", {
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
      this._log("INFO", "page_vanished_suspected", { freinsId, httpStatus });
      return {
        freinsId, url, judgment: "vanished_suspected",
        rawStatus: null, mediaStatus: "vanished", rawPrice: null, price: null,
        note: `ふれんず 消失疑い (HTTP ${httpStatus}, bodyClass: "${bodyClass.substring(0, 60)}")`,
      };
    }

    // 詳細ページ（body.detail）
    if (bodyClass.includes("detail")) {
      const rawStatus = await this._extractTradeStatus(page);
      const rawPrice = await this._extractPrice(page);
      const price = this.normalizePrice(rawPrice);
      this._log("INFO", "raw_status_extracted", { freinsId, rawStatus, rawPrice, price });

      if (rawStatus === null) {
        return {
          freinsId, url, judgment: "error",
          rawStatus: null, mediaStatus: "unknown", rawPrice, price,
          note: "取引状況ラベルが見つかりませんでした（ページ構造を要確認）",
        };
      }

      const mediaStatus = this.translateStatus(rawStatus);
      return {
        freinsId, url, judgment: mediaStatus,
        rawStatus, mediaStatus, rawPrice, price,
        note: `取引状況原文: 「${rawStatus}」`,
      };
    }

    // 想定外のページ構造
    this._log("WARN", "unknown_page_structure", {
      freinsId, httpStatus,
      bodyClass: bodyClass.substring(0, 120),
    });
    return {
      freinsId, url, judgment: "error",
      rawStatus: null, mediaStatus: null, rawPrice: null, price: null,
      note: `不明なページ構造 (HTTP ${httpStatus}, bodyClass: "${bodyClass.substring(0, 80)}")`,
    };
  }
}
