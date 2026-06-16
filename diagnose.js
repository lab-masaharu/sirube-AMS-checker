// ============================================================
// 診断スクリプト: ログイン後にAMSが何を表示するかを確認する
// 使い方: node diagnose.js
// 認証情報は .env から読む（crawl-ams.js と同じ）
// ============================================================

import { chromium } from "playwright";
import dotenv from "dotenv";
import fs from "node:fs";

dotenv.config();

const AMS_LOGIN_URL = process.env.AMS_LOGIN_URL || "https://agent-master.jp/";
const AMS_EMAIL = process.env.AMS_EMAIL;
const AMS_PASSWORD = process.env.AMS_PASSWORD;

function line(s) { console.log(s); }

async function main() {
  if (!AMS_EMAIL || !AMS_PASSWORD) {
    line("[エラー] .env に AMS_EMAIL / AMS_PASSWORD を設定してください。");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  line("=== 1. ログインページを開く ===");
  await page.goto(AMS_LOGIN_URL, { waitUntil: "domcontentloaded" });

  // ログイン前の状態を記録
  const beforeUrl = page.url();
  const hasEmailField = await page.$("#ipt_user_email_1");
  const hasLoginBtn = await page.$("#btnLogin");
  const hasSearchFormBefore = await page.$("#fSearchCondition");
  line(`ログイン前 URL          : ${beforeUrl}`);
  line(`ログイン前 #ipt_user_email_1 ある?: ${!!hasEmailField}`);
  line(`ログイン前 #btnLogin     ある?: ${!!hasLoginBtn}`);
  line(`ログイン前 #fSearchCondition ある?: ${!!hasSearchFormBefore}  ← これがtrueだと誤判定の原因`);

  line("\n=== 2. ログイン情報を入力して送信 ===");
  if (hasEmailField) await page.fill("#ipt_user_email_1", AMS_EMAIL);
  if (await page.$("#ipt_user_password")) await page.fill("#ipt_user_password", AMS_PASSWORD);
  if (hasLoginBtn) {
    await page.click("#btnLogin");
    line("ログインボタンをクリックしました。");
  } else {
    line("[注意] #btnLogin が見つかりませんでした。ログイン画面の構造が想定と違います。");
  }

  line("\n=== 3. 遷移を待つ（最大15秒、ネットワーク静止まで） ===");
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {
    line("networkidle待ちタイムアウト（致命ではない・続行）");
  });
  await page.waitForTimeout(3000); // 念のため追加で3秒

  // ログイン後の状態を記録
  const afterUrl = page.url();
  line(`\nログイン後 URL          : ${afterUrl}`);

  // 主要要素の有無を確認
  const checks = {
    "#fSearchCondition": null,
    "#listArea": null,
    "#listBody": null,
    "#listBody tr[data-href]": null,
    "#hidden_object_count": null,
  };
  for (const sel of Object.keys(checks)) {
    const el = await page.$(sel);
    checks[sel] = !!el;
  }
  line("\n--- ログイン後の主要要素の有無 ---");
  for (const [sel, exists] of Object.entries(checks)) {
    line(`  ${exists ? "✓ある" : "✗ない"}  ${sel}`);
  }

  // hidden_object_count の値
  const cnt = await page.$eval("#hidden_object_count", (el) => el.value).catch(() => "(取得不可)");
  line(`\n#hidden_object_count の値 : ${cnt}`);

  // listBody の行数
  const rowCount = await page.$$eval("#listBody tr[data-href]", (trs) => trs.length).catch(() => 0);
  line(`#listBody の物件行数      : ${rowCount}`);

  // ページタイトルと body 先頭テキスト（何の画面か判断材料）
  const title = await page.title();
  line(`\nページタイトル            : ${title}`);

  // スクリーンショット保存
  await page.screenshot({ path: "after-login.png", fullPage: false });
  line(`\nスクリーンショットを after-login.png に保存しました。`);

  // ログイン後HTMLの listArea 周辺だけ保存（長すぎないよう先頭3000文字）
  const listAreaHtml = await page
    .$eval("#listArea", (el) => el.innerHTML)
    .catch(() => "(#listArea が存在しません)");
  fs.writeFileSync("listarea-dump.txt", listAreaHtml.slice(0, 3000), "utf-8");
  line(`#listArea の中身を listarea-dump.txt に保存しました（先頭3000文字）。`);

  line("\n=== 10秒後にブラウザを閉じます。画面を目視確認してください ===");
  await page.waitForTimeout(10000);

  await browser.close();
}

main().catch((e) => {
  console.error("診断中にエラー:", e.message);
  process.exit(1);
});
