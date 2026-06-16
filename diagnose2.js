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
  line("=== ログイン ===");
  await page.goto(AMS_LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.fill("#ipt_user_email_1", AMS_EMAIL);
  await page.fill("#ipt_user_password", AMS_PASSWORD);
  await page.click("#btnLogin");
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  line("ログイン後 URL: " + page.url());

  line("\n=== クリック可能要素の一覧 ===");
  const clickables = await page.evaluate(() => {
    const out = [];
    const els = document.querySelectorAll('button, a, input[type=button], input[type=submit], [onclick]');
    els.forEach((el) => {
      const text = (el.innerText || el.value || "").trim().slice(0, 30);
      const onclick = el.getAttribute("onclick") || "";
      const id = el.id || "";
      const tag = el.tagName.toLowerCase();
      if (text || onclick || id) out.push({ tag, id, text, onclick: onclick.slice(0, 80) });
    });
    return out;
  });
  clickables.forEach((c, i) => {
    line("[" + i + "] <" + c.tag + "> id=\"" + c.id + "\" text=\"" + c.text + "\" onclick=\"" + c.onclick + "\"");
  });

  line("\n=== select要素の選択肢 ===");
  const selects = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("select").forEach((sel) => {
      const opts = Array.from(sel.options).map((o) => ({ value: o.value, label: o.text.trim() }));
      out.push({ id: sel.id, name: sel.name, options: opts });
    });
    return out;
  });
  selects.forEach((s) => {
    line("select id=\"" + s.id + "\" name=\"" + s.name + "\"");
    s.options.forEach((o) => line("    value=\"" + o.value + "\"  ラベル=\"" + o.label + "\""));
  });

  const html = await page.content();
  fs.writeFileSync("top-after-login.html", html, "utf-8");
  line("\nログイン後トップの全HTMLを top-after-login.html に保存しました。");

  line("\n=== 15秒後に閉じます ===");
  await page.waitForTimeout(15000);
  await browser.close();
}

main().catch((e) => { console.error("診断中にエラー:", e.message); process.exit(1); });
