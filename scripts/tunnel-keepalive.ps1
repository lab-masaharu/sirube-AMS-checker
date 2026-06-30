#Requires -Version 5.1
# ============================================================
# sirube-ams-checker / SSH逆トンネル keepalive スクリプト
# system_code: sys_ops_ams_checker
#
# このPC → VPS へのSSH逆トンネルを維持し、切れたら自動で再接続する。
# VPS側の REMOTE_PORT をこのPCの LOCAL_PORT（ふれんずMCPサーバー）へ転送する。
#
# 前提:
#   - このPC上で MCPサーバー（src/mcp/freins-server.js）が起動済みであること
#   - SSH鍵認証が設定済みで、パスワード入力なしで接続できること
#
# 使用方法: pwsh -File scripts\tunnel-keepalive.ps1
# ============================================================

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

# ── 設定（ここを変更するだけで別環境に対応可能） ──────────────────
$VPS_HOST       = "133.242.131.221"   # VPSのIPアドレス
$VPS_USER       = "ubuntu"             # VPSのSSHユーザー
$REMOTE_PORT    = 5600                 # VPS側ポート（n8n/Claudeが呼ぶ側）
$LOCAL_PORT     = 5600                 # このPCのポート（MCPサーバーが待ち受け）
$MAX_FAILURES   = 3                    # 連続失敗でスクリプトを停止するしきい値
$RETRY_WAIT_SEC = 5                    # 再接続前の待機秒数
$STABLE_SEC     = 10                   # stderrにエラーが無いままこの秒数以上稼働したら「安定接続」と確定する
$POLL_INTERVAL_MS = 2000               # 監視ポーリング間隔（ミリ秒）。stderr確認・安定判定・Ctrl+C応答に使う

# sshが標準エラーに出す既知の致命的エラー文言。
# これが検出された場合、稼働時間に関わらず「接続失敗」と確定する
# （ssh プロセスの生存 ≠ トンネルの実際の接続成功、を区別するための仕組み）。
$FATAL_PATTERNS = @(
    "Connection timed out",
    "Connection refused",
    "Could not resolve hostname",
    "Permission denied",
    "No route to host",
    "Network is unreachable",
    "Operation timed out",
    "forwarding failed",
    "Host key verification failed"
)

# ── パス設定 ────────────────────────────────────────────────────
$PROJECT_ROOT = Split-Path $PSScriptRoot -Parent
$LOG_DIR      = Join-Path $PROJECT_ROOT "logs"
$LOG_FILE     = Join-Path $LOG_DIR "tunnel-keepalive.log"
$STATUS_FILE  = Join-Path $PROJECT_ROOT "tunnel-status.json"

# ── 初期化 ──────────────────────────────────────────────────────
if (-not (Test-Path $LOG_DIR)) {
    New-Item -ItemType Directory -Path $LOG_DIR -Force | Out-Null
}

# ── スクリプトスコープの共有変数 ──────────────────────────────────
$script:lastConnectedAt = $null   # 最後に安定接続を確認した時刻
$script:currentProc     = $null   # 現在のSSHプロセス（finally でのクリーンアップ用）

# ── ヘルパー関数 ────────────────────────────────────────────────

function Write-Log {
    param(
        [ValidateSet("INFO","WARN","ERROR")][string]$Level,
        [string]$Message
    )
    $ts   = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts][$Level] $Message"
    try { Add-Content -Path $LOG_FILE -Value $line -Encoding UTF8 } catch {}
    $color = switch ($Level) {
        "ERROR" { "Red" }
        "WARN"  { "Yellow" }
        default { "Cyan" }
    }
    Write-Host $line -ForegroundColor $color
}

function Write-StatusFile {
    param(
        [string]$Status,
        [int]$FailCount,
        [AllowNull()][object]$LastExitCode,
        [AllowNull()][string]$CauseCandidates
    )
    $obj = [ordered]@{
        status              = $Status
        fail_count          = $FailCount
        last_updated_at     = (Get-Date -Format "o")
        last_connected_at   = $script:lastConnectedAt
        last_exit_code      = $LastExitCode
        cause_candidates    = $CauseCandidates
        vps_host            = $VPS_HOST
        remote_port         = $REMOTE_PORT
        local_port          = $LOCAL_PORT
        # 将来の拡張余地:
        #   status = "mcp_unreachable" : VPS側ポートにTCP到達可能だがMCPサーバーが応答しない
        #   status = "vps_unreachable" : VPS自体に到達できない
        # これらを区別するには、接続後にMCPのhealth checkを追加する（現在は未実装）。
    }
    try {
        $obj | ConvertTo-Json | Set-Content -Path $STATUS_FILE -Encoding UTF8 -Force
    } catch {
        Write-Log "WARN" "ステータスファイルの書き込みに失敗しました: $_"
    }
}

function Test-FatalSshError {
    # stderrの内容に既知の致命的エラー文言が含まれるか確認する。
    # 含まれていればその文言を返す（= 接続失敗の確定）。含まれなければ $null。
    param([string]$Content)
    if ([string]::IsNullOrWhiteSpace($Content)) { return $null }
    foreach ($pattern in $FATAL_PATTERNS) {
        if ($Content.IndexOf($pattern, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $pattern
        }
    }
    return $null
}

function Start-SshTunnel {
    # -N: コマンドを実行しない（トンネル専用フラグ）。
    # 非対話型・バックグラウンド実行には必須。手動テスト用コマンドから追加している。
    param([string]$StderrPath)
    $sshArgs = @(
        "-N",
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ConnectTimeout=10",
        "-R", "${REMOTE_PORT}:localhost:${LOCAL_PORT}",
        "${VPS_USER}@${VPS_HOST}"
    )
    # 標準エラーをファイルにリダイレクトし、終了後に Test-FatalSshError で検査する。
    return Start-Process `
        -FilePath     "ssh" `
        -ArgumentList $sshArgs `
        -NoNewWindow  `
        -RedirectStandardError $StderrPath `
        -PassThru
}

# ── 起動確認 ─────────────────────────────────────────────────────
if (-not (Get-Command "ssh" -ErrorAction SilentlyContinue)) {
    Write-Log "ERROR" "ssh コマンドが見つかりません。OpenSSH がインストール済みで PATH に含まれているか確認してください。"
    exit 1
}

# ── メインループ ─────────────────────────────────────────────────
$failCount = 0

Write-Log "INFO" "================================================================"
Write-Log "INFO" "トンネル keepalive 起動"
Write-Log "INFO" "  接続先        : ${VPS_USER}@${VPS_HOST}"
Write-Log "INFO" "  転送          : VPS:${REMOTE_PORT} → このPC:${LOCAL_PORT}"
Write-Log "INFO" "  最大連続失敗数: ${MAX_FAILURES} 回"
Write-Log "INFO" "  再接続待機    : ${RETRY_WAIT_SEC} 秒"
Write-Log "INFO" "  安定判定秒数  : ${STABLE_SEC} 秒"
Write-Log "INFO" "================================================================"
Write-StatusFile -Status "starting" -FailCount 0 -LastExitCode $null -CauseCandidates $null

try {
    while ($true) {

        # ── 接続ラベル（表示用） ──────────────────────────────────
        $attemptLabel = if ($failCount -eq 0) { "接続開始" } `
                        else { "再接続試行 ${failCount} / ${MAX_FAILURES}" }
        Write-Log "INFO" "──────────────────────────────────────────────────"
        Write-Log "INFO" $attemptLabel
        Write-StatusFile -Status "connecting" -FailCount $failCount -LastExitCode $null -CauseCandidates $null

        # ── SSHプロセス起動 ───────────────────────────────────────
        $startTime             = Get-Date
        $stderrPath            = Join-Path $LOG_DIR ("ssh-stderr-{0}.tmp" -f ([guid]::NewGuid().ToString("N").Substring(0,8)))
        $script:currentProc    = Start-SshTunnel -StderrPath $stderrPath
        Write-Log "INFO" "SSHプロセス起動 (PID: $($script:currentProc.Id))"

        # ── プロセス監視（POLL_INTERVAL_MS ごとにポーリング） ──────
        # 安定接続の確定は「プロセスが生きている途中」で行う（でないと、繋がり続けている間
        # ずっと status=connecting のままになってしまう）。
        # ただし誤判定（最初のバグ）を防ぐため、毎回 stderr を確認し、
        # 「エラーが出ていない」ことを確認した上でのみ安定と判定する。
        # 安定確定前に致命的エラーを検出したら、プロセスの自然終了を待たずに即座に終了させる。
        $connectedConfirmed = $false
        $matchedError       = $null

        while ($true) {
            $exited = $script:currentProc.WaitForExit($POLL_INTERVAL_MS)

            $stderrSoFar = ""
            if (Test-Path $stderrPath) {
                $stderrSoFar = Get-Content -Raw -Path $stderrPath -ErrorAction SilentlyContinue
            }
            $detectedError = Test-FatalSshError -Content $stderrSoFar

            if ($detectedError -and -not $connectedConfirmed) {
                # まだ安定接続が確定していない段階で致命的エラーを検出 → 即座に失敗確定
                $matchedError = $detectedError
                if (-not $exited) {
                    Write-Log "WARN" "stderrに失敗の証拠を検出したためプロセスを終了します: `"${detectedError}`""
                    try { $script:currentProc.Kill() } catch {}
                    $script:currentProc.WaitForExit(3000) | Out-Null
                }
                break
            }

            if (-not $connectedConfirmed -and -not $detectedError) {
                $elapsed = [int]((Get-Date) - $startTime).TotalSeconds
                if ($elapsed -ge $STABLE_SEC) {
                    # stderrにエラーが無いことを確認した上で、生存中に安定接続を確定する。
                    $connectedConfirmed     = $true
                    $failCount              = 0
                    $script:lastConnectedAt = Get-Date -Format "o"
                    Write-Log "INFO" "接続安定を確認（${elapsed}秒・stderrにエラーなし）。失敗カウンタをリセット。"
                    Write-StatusFile -Status "connected" -FailCount $failCount -LastExitCode $null -CauseCandidates $null
                }
            }

            if ($exited) { break }
        }

        # ── プロセス終了後の後始末 ────────────────────────────────
        $exitCode           = $script:currentProc.ExitCode
        $script:currentProc = $null
        $duration           = [int]((Get-Date) - $startTime).TotalSeconds

        if (Test-Path $stderrPath) {
            if (-not $matchedError) {
                $finalStderr  = Get-Content -Raw -Path $stderrPath -ErrorAction SilentlyContinue
                $matchedError = Test-FatalSshError -Content $finalStderr
            }
            Remove-Item -Path $stderrPath -ErrorAction SilentlyContinue
        }

        Write-Log "WARN" "SSHプロセス終了 (終了コード: ${exitCode}, 稼働時間: ${duration}秒)"

        if ($connectedConfirmed) {
            # ── 安定接続が一度確定していた → 切断は「安定後の切断」として扱う ──
            # （failCount はすでに 0。安定確定後に出たエラー文言があっても、
            #   一度確立した接続の切断として扱い、失敗カウントは増やさない）
            Write-Log "INFO" "安定接続後の切断。${RETRY_WAIT_SEC}秒後に再接続します。"
            Write-StatusFile -Status "disconnected_after_stable" -FailCount $failCount -LastExitCode $exitCode -CauseCandidates $null

        } else {
            # ── 安定確定前に終了した（stderrでの確定 or 原因不明の早期切断） ──
            $failCount++
            $reason = if ($matchedError) { $matchedError } else { "原因不明の早期切断（stderrに既知のエラー文言なし、${duration}秒で終了）" }
            Write-Log "WARN" "接続失敗と判定（理由: ${reason}）。連続失敗: ${failCount} / ${MAX_FAILURES}"
            Write-StatusFile -Status "disconnected_quick" -FailCount $failCount -LastExitCode $exitCode -CauseCandidates $reason

            if ($failCount -ge $MAX_FAILURES) {
                # ── 連続失敗上限に到達 → 停止 ─────────────────────
                Write-StatusFile -Status "stopped_max_failures" -FailCount $failCount -LastExitCode $exitCode -CauseCandidates $reason

                Write-Host ""
                Write-Host "================================================================" -ForegroundColor Red
                Write-Log "ERROR" "トンネルが ${MAX_FAILURES} 回連続で再接続に失敗しました。"
                Write-Log "ERROR" "自動復活を停止します。手動確認が必要です。"
                Write-Log "ERROR" "直近の失敗理由: ${reason}"
                Write-Log "ERROR" "考えられる原因:"
                Write-Log "ERROR" "  - VPS（${VPS_HOST}）に到達できない"
                Write-Log "ERROR" "  - SSH認証鍵が無効または期限切れ"
                Write-Log "ERROR" "  - ネットワーク障害"
                Write-Log "ERROR" "  - このPCでMCPサーバーが停止している（ポート ${LOCAL_PORT}）"
                Write-Log "ERROR" "ステータスファイル: ${STATUS_FILE}"
                Write-Host "================================================================" -ForegroundColor Red
                Write-Host ""
                exit 1
            }
        }

        # ── 再接続まで待機 ────────────────────────────────────────
        Write-Log "INFO" "${RETRY_WAIT_SEC} 秒後に再接続します..."
        Start-Sleep -Seconds $RETRY_WAIT_SEC
    }

} finally {
    # Ctrl+C やエラー終了時のクリーンアップ（SSHプロセスが残っていれば終了させる）
    if ($null -ne $script:currentProc -and -not $script:currentProc.HasExited) {
        Write-Log "INFO" "SSHプロセスを停止します (PID: $($script:currentProc.Id))"
        try { $script:currentProc.Kill() } catch {}
    }
    Write-StatusFile -Status "script_exited" -FailCount $failCount -LastExitCode $null -CauseCandidates $null
    Write-Log "INFO" "トンネル keepalive スクリプト終了"
}
