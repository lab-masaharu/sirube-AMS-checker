import { chromium } from "playwright";
import dotenv from "dotenv";
import fs from "node:fs";
dotenv.config();
const AMS_LOGIN_URL = process.env.AMS_LOGIN_URL || "https://agent-master.jp/";
const AMS_EMAIL = process.env.AMS_EMAIL;
const AMS_PASSWORD = process.env.AMS_PASSWORD;
function line(s) { console.log(s); }

async function main() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto(AMS_LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.fill("#ipt_user_email_1", AMS_EMAIL);
  await page.fill("#ipt_user_password", AMS_PASSWORD);
  await page.click("#btnLogin");
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  await page.click('a:has-text("検索画面")');
  await page.waitForTimeout(3000);
  line("検索画面クリック後 URL: " + page.url());

  // すべてのフレームを列挙
  line("\n=== フレーム一覧 ===");
  const frames = page.frames();
  line("フレーム数: " + frames.length);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    line("[" + i + "] name=\"" + f.name() + "\" url=" + f.url());
  }

  // 各フレーム内のチェックボックスとボタンを調べる
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const cbCount = await f.evaluate(() => document.querySelectorAll('input[type=checkbox]').length).catch(() => -1);
    const btnTexts = await f.evaluate(() => {
      return Array.from(document.querySelectorAll('button, a, input[type=button], input[type=submit]'))
        .map(el => (el.innerText || el.value || "").trim())
        .filter(t => t).slice(0, 40);
    }).catch(() => []);
    line("\n--- フレーム[" + i + "] checkbox数=" + cbCount + " ---");
    line("  ボタン類: " + JSON.stringify(btnTexts));
    // ステータス系チェックボックスの詳細
    const cbDetail = await f.evaluate(() => {
      return Array.from(document.querySelectorAll('input[type=checkbox]')).slice(0, 15).map(el => ({
        id: el.id, name: el.name, value: el.value,
        label: (el.closest("label")?.innerText || el.parentElement?.innerText || "").trim().slice(0,16)
      }));
    }).catch(() => []);
    if (cbDetail.length) cbDetail.forEach(c => line("    checkbox id=\"" + c.id + "\" name=\"" + c.name + "\" value=\"" + c.value + "\" label=\"" + c.label + "\""));
  }

  // 検索画面クリック後の全フレームHTMLを保存
  for (let i = 0; i < frames.length; i++) {
    const h = await frames[i].content().catch(() => "");
    if (h) fs.writeFileSync("frame-" + i + ".html", h, "utf-8");
  }
  line("\n各フレームHTMLを frame-0.html, frame-1.html ... に保存しました。");
  line("\n=== 15秒後に閉じます ===");
  await page.waitForTimeout(15000);
  await browser.close();
}
main().catch((e) => { console.error("エラー:", e.message); process.exit(1); });
