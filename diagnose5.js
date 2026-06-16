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

  // iframe(search.html)を取得
  const frame = page.frames().find(f => f.url().includes("search.html"));
  if (!frame) { line("検索iframeが見つかりません"); await browser.close(); return; }
  line("検索iframe URL: " + frame.url());

  // 公開・商談中をチェック（未チェックなら入れる）
  for (const id of ["#obj_status1_chk", "#obj_status2_chk"]) {
    const checked = await frame.$eval(id, el => el.checked).catch(() => null);
    if (checked === false) await frame.click(id);
    line(id + " checked=" + await frame.$eval(id, el => el.checked).catch(() => "?"));
  }

  // 「リストで表示」(a.btnExec)をクリック
  await frame.click("a.btnExec");
  line("リストで表示をクリックしました。");
  await page.waitForTimeout(5000);

  // リストがどこに出たか調査：親ページとiframe両方を確認
  line("\n=== リスト表示後の調査 ===");
  // 親ページ
  const parentRows = await page.$$eval("#listBody tr[data-href], tr[data-href]", trs => trs.length).catch(() => 0);
  const parentCount = await page.$eval("#hidden_object_count", el => el.value).catch(() => "(なし)");
  line("親ページ: tr[data-href]数=" + parentRows + " / #hidden_object_count=" + parentCount);

  // 全フレーム再取得して調査
  const frames2 = page.frames();
  line("現在のフレーム数: " + frames2.length);
  for (let i = 0; i < frames2.length; i++) {
    const f = frames2[i];
    const rows = await f.$$eval("tr[data-href]", trs => trs.length).catch(() => 0);
    const cnt = await f.$eval("#hidden_object_count", el => el.value).catch(() => "(なし)");
    line("[フレーム" + i + "] url=" + f.url().slice(0,50) + " tr[data-href]数=" + rows + " 件数hidden=" + cnt);
    if (rows > 0) {
      // 最初の3行のobject_idとリンクを見る
      const sample = await f.evaluate(() => {
        return Array.from(document.querySelectorAll("tr[data-href]")).slice(0,3).map(tr => {
          const id = tr.getAttribute("data-href");
          const links = Array.from(tr.querySelectorAll("a[href]")).map(a => a.getAttribute("href")).filter(h => h && h.startsWith("http"));
          return { id, links };
        });
      });
      line("  サンプル: " + JSON.stringify(sample));
      const h = await f.content();
      fs.writeFileSync("list-frame-" + i + ".html", h, "utf-8");
      line("  → list-frame-" + i + ".html に保存");
    }
  }
  line("\n=== 20秒後に閉じます。リストが見えているか確認してください ===");
  await page.waitForTimeout(20000);
  await browser.close();
}
main().catch((e) => { console.error("エラー:", e.message); process.exit(1); });
