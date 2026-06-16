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
  line("ログイン後: " + page.url());

  // 「検索画面」リンクをクリック
  await page.click('a:has-text("検索画面")');
  await page.waitForTimeout(3000);
  line("検索画面クリック後: " + page.url());

  // チェックボックスとボタンを洗い出す
  line("\n=== checkbox / radio 一覧 ===");
  const inputs = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('input[type=checkbox], input[type=radio]').forEach((el) => {
      const labelText = (el.closest("label")?.innerText || el.parentElement?.innerText || "").trim().slice(0, 20);
      out.push({ type: el.type, id: el.id, name: el.name, value: el.value, checked: el.checked, label: labelText });
    });
    return out;
  });
  inputs.forEach((c, i) => line("[" + i + "] type=" + c.type + " id=\"" + c.id + "\" name=\"" + c.name + "\" value=\"" + c.value + "\" checked=" + c.checked + " label=\"" + c.label + "\""));

  line("\n=== ボタン・リンク一覧（リストで表示を探す） ===");
  const btns = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('button, a, input[type=button], input[type=submit]').forEach((el) => {
      const text = (el.innerText || el.value || "").trim().slice(0, 30);
      const onclick = el.getAttribute("onclick") || "";
      if (text) out.push({ tag: el.tagName.toLowerCase(), id: el.id, text, onclick: onclick.slice(0, 80) });
    });
    return out;
  });
  btns.forEach((c, i) => line("[" + i + "] <" + c.tag + "> id=\"" + c.id + "\" text=\"" + c.text + "\" onclick=\"" + c.onclick + "\""));

  const html = await page.content();
  fs.writeFileSync("search-screen.html", html, "utf-8");
  line("\n検索画面の全HTMLを search-screen.html に保存しました。");
  line("\n=== 15秒後に閉じます ===");
  await page.waitForTimeout(15000);
  await browser.close();
}
main().catch((e) => { console.error("エラー:", e.message); process.exit(1); });
