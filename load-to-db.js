// ============================================================
// sirube-ams-checker / 投入スクリプト load-to-db.js
// results.json を読み、properties（物件マスタ）へ UPSERT する。
// 突合結果(status_checks)はこの段階では触らない。
// ============================================================

import fs from "node:fs";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const SYSTEM_CODE = "sys_ops_ams_checker";

function log(level, action, metadata = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level, systemCode: SYSTEM_CODE, service: "load-to-db", action, metadata,
  }));
}

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5544", 10),
  user: process.env.DB_USER || "sirube",
  password: process.env.DB_PASSWORD || "sirube_local_pw",
  database: process.env.DB_NAME || "sirube_ams",
});

const TENANT = "sirube_office";

async function main() {
  if (!fs.existsSync("results.json")) {
    console.error("[エラー] results.json が見つかりません。先に crawl-ams.js を実行してください。");
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync("results.json", "utf-8"));
  const rows = data.rows || [];
  log("INFO", "start", { totalRows: rows.length, crawledAt: data.crawledAt });

  const client = await pool.connect();
  let inserted = 0, updated = 0;
  const seenObjectIds = [];

  try {
    await client.query("BEGIN");

    for (const r of rows) {
      seenObjectIds.push(r.objectId);
      // UPSERT: あれば更新（last_seen_at, ams_status, media系を更新）、なければ挿入
      const res = await client.query(
        `INSERT INTO properties
           (tenant_id, object_id, media, media_url, freins_id, ams_status,
            first_seen_at, last_seen_at, status, system_code)
         VALUES ($1,$2,$3,$4,$5,$6, now(), now(), 'active', $7)
         ON CONFLICT (tenant_id, object_id) DO UPDATE SET
           media       = EXCLUDED.media,
           media_url   = EXCLUDED.media_url,
           freins_id   = EXCLUDED.freins_id,
           ams_status  = EXCLUDED.ams_status,
           last_seen_at = now(),
           status      = 'active',
           updated_at  = now()
         RETURNING (xmax = 0) AS inserted`,
        [TENANT, r.objectId, r.media, r.mediaUrl || null, r.freinsId || null,
         r.amsStatus || null, SYSTEM_CODE]
      );
      if (res.rows[0].inserted) inserted++; else updated++;
    }

    // 今回の巡回に出てこなかった既存物件は status='gone' にする
    const goneRes = await client.query(
      `UPDATE properties
         SET status='gone', updated_at=now()
       WHERE tenant_id=$1
         AND system_code=$2
         AND status='active'
         AND object_id <> ALL($3::text[])`,
      [TENANT, SYSTEM_CODE, seenObjectIds]
    );

    await client.query("COMMIT");
    log("INFO", "done", {
      inserted, updated, markedGone: goneRes.rowCount, total: rows.length,
    });

    // 投入後の確認集計
    const summary = await client.query(
      `SELECT media, status, count(*)::int AS cnt
         FROM properties WHERE tenant_id=$1
        GROUP BY media, status ORDER BY media, status`, [TENANT]
    );
    console.log("\n========== DB投入結果 ==========");
    console.log(`新規挿入: ${inserted} 件 / 更新: ${updated} 件 / 消失(gone)化: ${goneRes.rowCount} 件`);
    console.log("--- properties 集計（media × status）---");
    for (const row of summary.rows) {
      console.log(`  ${row.media.padEnd(7)} ${row.status.padEnd(7)} : ${row.cnt}`);
    }
    console.log("================================\n");
  } catch (err) {
    await client.query("ROLLBACK");
    log("ERROR", "load_failed", { message: err.message });
    console.error("[エラー]", err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(() => process.exit(1));