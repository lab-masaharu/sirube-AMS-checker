import { spawnSync } from "node:child_process";

const baseEnv = {
  ...process.env,
  HEADLESS: process.env.HEADLESS ?? "false",
  PAGE_WAIT_MS: process.env.PAGE_WAIT_MS ?? "1200",
  MAX_PAGES: process.env.MAX_PAGES ?? "30",
};

function runStep(label, command, args, extraEnv = {}) {
  console.log(`\n========== ${label} ==========`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...baseEnv, ...extraEnv },
    shell: false,
  });

  if (result.status !== 0) {
    const code = result.status ?? result.signal ?? 1;
    throw new Error(`${label} failed (exit=${code})`);
  }
}

function runOptionalStep(label, command, args, extraEnv = {}) {
  console.log(`\n========== ${label} ==========`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...baseEnv, ...extraEnv },
    shell: false,
  });

  if (result.status !== 0) {
    const code = result.status ?? result.signal ?? 1;
    console.log(`\n[注意] ${label} は exit=${code} で終了しました。DB未起動ならこのデモではスキップして続行します。\n`);
    return false;
  }

  return true;
}

try {
  runStep(
    "1. AMSログイン・条件絞り込み・取得",
    "node",
    ["crawl-ams.js"],
    { HEADLESS: process.env.HEADLESS ?? "false", MAX_PAGES: process.env.MAX_PAGES ?? "30" }
  );

  const dbSaved = runOptionalStep(
    "2. DBへ保存",
    "node",
    ["load-to-db.js"],
    { HEADLESS: "true" }
  );

  if (dbSaved) {
    runStep(
      "3. 全件の差分突き合わせ",
      "node",
      ["src/run-batch.js", process.env.DEMO_BATCH_LIMIT ?? "all", "0"],
      { HEADLESS: process.env.HEADLESS ?? "false" }
    );
  } else {
    runStep(
      "3. DBなしで AMS→WEB 差分一覧を生成",
      "node",
      ["src/demo/ams-web-diff.js"],
      { HEADLESS: process.env.HEADLESS ?? "false" }
    );
  }

  console.log(`\nAMSデモ完了: ログイン → 条件絞り込み → ${dbSaved ? "DB保存 → 全件差分突き合わせ" : "DBなしで差分一覧"} まで実行しました。\n`);
} catch (err) {
  console.error("\n[AMSデモ失敗]", err.message, "\n");
  process.exit(1);
}