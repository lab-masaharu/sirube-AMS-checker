// ============================================================
// sirube-ams-checker / status_checks 記録ストア
// system_code: sys_ops_ams_checker
//
// status_checks テーブルへの append-only 記録（媒体非依存）。
// run-freins-batch.js と recheck-vanished.js で重複していた
// insertStatusCheck(s) をここに統合。
//
// 呼び出し側はトランザクション（BEGIN/COMMIT/ROLLBACK）を管理すること。
// ============================================================

const SYSTEM_CODE = "sys_ops_ams_checker";
const TENANT = "sirube_office";

const INSERT_SQL = `
  INSERT INTO status_checks
    (tenant_id, object_id, checked_at, ams_status, media, media_status,
     judgment, review_status, note, run_id, system_code)
  VALUES ($1, $2, now(), $3, $4, $5, $6::judgment_t, 'pending', $7, $8, $9)
`;

// 1件記録
export async function insertStatusCheck(client, {
  objectId, amsStatus, media, mediaStatus, judgment, note, runId,
}) {
  await client.query(INSERT_SQL, [
    TENANT, objectId, amsStatus, media, mediaStatus, judgment, note, runId, SYSTEM_CODE,
  ]);
}

// 複数件をまとめて記録（呼び出し側が BEGIN/COMMIT でラップすること）
export async function insertStatusChecks(client, checks) {
  for (const c of checks) {
    await insertStatusCheck(client, c);
  }
}
