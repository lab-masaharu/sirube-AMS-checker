import { chromium } from "playwright";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";
import dotenv from "dotenv";
import { FreinsAdapter } from "../adapters/FreinsAdapter.js";

dotenv.config();

const PORT = 5600;
const HEADLESS = (process.env.HEADLESS ?? "true").toLowerCase() === "true";
const SYSTEM_CODE = "sys_ops_ams_checker";

function log(level, action, metadata = {}) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      systemCode: SYSTEM_CODE,
      service: "freins-mcp",
      action,
      metadata,
    })
  );
}

// ── セッション管理（プロセス内シングルトン） ──────────────────────
// browser / page をプロセス生存期間中保持し、ログインセッションを使い回す。
// 最初の fetch_freins_status 呼び出し時に遅延初期化する。

const adapter = new FreinsAdapter();
let _browser = null;
let _page = null;
let _loggedIn = false;

// ページへの同時アクセスを防ぐ簡易 mutex
// Promise チェーンで直列化する。前のリクエストが終わってから次を開始。
let _pageLock = Promise.resolve();

function withPageLock(fn) {
  const prev = _pageLock;
  let unlock;
  _pageLock = new Promise((resolve) => { unlock = resolve; });
  return prev.then(fn).finally(unlock);
}

async function ensureSession() {
  if (!_browser) {
    log("INFO", "browser_launch", { headless: HEADLESS });
    _browser = await chromium.launch({ headless: HEADLESS });
    _page = await _browser.newPage();
    _loggedIn = false;
  }
  if (!_loggedIn) {
    log("INFO", "login_start", {});
    await adapter.login(_page);
    _loggedIn = true;
    log("INFO", "login_done", {});
  }
}

async function fetchWithSessionRetry(freinsId) {
  return withPageLock(async () => {
    await ensureSession();

    let result = await adapter.fetchStatus(_page, freinsId);

    // セッション切れ → 再ログイン後リトライ（1回まで）
    if (result.judgment === "error" && result.note?.includes("セッション切れ")) {
      log("WARN", "session_expired_relogin", { freinsId });
      _loggedIn = false;
      await ensureSession();
      result = await adapter.fetchStatus(_page, freinsId);
    }

    return result;
  });
}

// ── MCP サーバーファクトリ ────────────────────────────────────────
// Streamable HTTP ステートレス方式: リクエストごとに McpServer を新規生成。
// Playwright session は上記シングルトンで共有するため影響なし。

function createServer() {
  const server = new McpServer({
    name: "freins-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "fetch_freins_status",
    {
      description:
        "ふれんず物件の掲載ステータスを取得する（freins_id を受け取り、rawStatus・mediaStatus・judgment を返す）",
      inputSchema: {
        freins_id: z.string().describe("ふれんずID（12桁、例: 000002488843）"),
      },
    },
    async ({ freins_id }) => {
      log("INFO", "tool_called", { freins_id });
      try {
        const result = await fetchWithSessionRetry(freins_id);
        log("INFO", "tool_result", {
          freins_id,
          judgment: result.judgment,
          mediaStatus: result.mediaStatus,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        log("ERROR", "tool_error", { freins_id, message: err.message });
        // 403/429 アクセス拒否 → プロセスごと停止（CLAUDE.md §11 慎重策）
        if (err.message.includes("[STOP]")) {
          log("FATAL", "access_denied_shutdown", { message: err.message });
          setTimeout(() => process.exit(1), 200);
        }
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: err.message }, null, 2) },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

// ── Express / HTTP ────────────────────────────────────────────────
const app = createMcpExpressApp();

app.post("/mcp", async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    log("ERROR", "request_error", { message: err.message });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (use POST)" },
    id: null,
  });
});

app.listen(PORT, (err) => {
  if (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
  log("INFO", "server_start", {
    port: PORT,
    endpoint: `http://localhost:${PORT}/mcp`,
    headless: HEADLESS,
  });
  console.log(`[freins-mcp] Streamable HTTP listening on port ${PORT}`);
  console.log(`[freins-mcp] Endpoint: http://localhost:${PORT}/mcp`);
});

process.on("SIGINT", async () => {
  log("INFO", "shutdown_start", {});
  if (_browser) {
    await _browser.close().catch(() => {});
    log("INFO", "browser_closed", {});
  }
  process.exit(0);
});
