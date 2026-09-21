import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import {
  batchTcpProbe,
  batchDownloadTest,
  type ITcpResult,
  type ISpeedTestResult,
} from './speed-test.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// 加载内置节点数据
const nodesJsonPath = path.join(ROOT, 'src', 'data', 'nodes.json');
const nodesRaw = fs.readFileSync(nodesJsonPath, 'utf-8');
const BUILTIN_NODES = JSON.parse(nodesRaw) as {
  ip: string;
  port: number;
  code: string;
  latency: number;
  city: string;
  country: string;
}[];

// ---- 会话管理 ----

type TestPhase = 'tcp' | 'download' | 'done' | 'cancelled' | 'idle';

interface ITestSession {
  id: string;
  params: ITestParams;
  phase: TestPhase;
  total: number; // 总节点数
  tcpDone: number;
  tcpFailed: number;
  downloadTotal: number; // 进入下载测速的候选数
  downloadDone: number;
  downloadFailed: number;
  currentIps: string[];
  tcpResults: ITcpResult[];
  speedResults: ISpeedTestResult[];
  log: string[];
}

interface ITestParams {
  tcpTimeoutMs: number;
  tcpConcurrency: number;
  downloadTimeoutMs: number;
  downloadConcurrency: number;
  minSpeedMbps: number;
  topPerCountry: number;
}

const sessions = new Map<string, ITestSession>();
const sseConnections = new Map<string, Set<http.ServerResponse>>();

function genSessionId(): string {
  return `st_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function sendSSE(
  res: http.ServerResponse,
  event: string,
  data: unknown,
) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastSSE(sessionId: string, event: string, data: unknown) {
  const conns = sseConnections.get(sessionId);
  if (!conns) return;
  for (const res of conns) {
    try {
      sendSSE(res, event, data);
    } catch {
      conns.delete(res);
    }
  }
}

function addLog(session: ITestSession, msg: string) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  session.log.push(line);
  if (session.log.length > 200) {
    session.log = session.log.slice(-200);
  }
  broadcastSSE(session.id, 'log', { message: line });
}

/**
 * 根据 TCP 结果筛选候选节点
 * 策略：每国按延迟升序取 topPerCountry * 4 个候选（确保足够下载测速样本）
 * 如果某国数量不足则取全部
 */
function selectCandidates(
  tcpResults: ITcpResult[],
  topPerCountry: number,
): { ip: string; port: number; code: string; city: string; country: string; latency: number; tcpLatency: number }[] {
  const success = tcpResults.filter((r) => r.success) as (ITcpResult & { tcpLatency: number })[];
  const groups = new Map<string, (ITcpResult & { tcpLatency: number })[]>();
  for (const r of success) {
    const list = groups.get(r.country) ?? [];
    list.push(r);
    groups.set(r.country, list);
  }

  const candidates: { ip: string; port: number; code: string; city: string; country: string; latency: number; tcpLatency: number }[] = [];
  // 每国取 topPerCountry * 3，但不低于 10 个
  const perCountryTake = Math.max(topPerCountry * 3, 10);
  for (const [, list] of groups) {
    list.sort((a, b) => a.tcpLatency - b.tcpLatency);
    const slice = list.slice(0, perCountryTake);
    for (const r of slice) {
      candidates.push({
        ip: r.ip,
        port: r.port,
        code: r.code,
        city: r.city,
        country: r.country,
        latency: r.refLatency,
        tcpLatency: r.tcpLatency,
      });
    }
  }
  return candidates;
}

/**
 * 两阶段测速主流程
 */
async function runTwoPhaseTest(
  session: ITestSession,
  nodes: { ip: string; port: number; code: string; latency: number; city: string; country: string }[],
) {
  const { params } = session;
  session.total = nodes.length;

  // ---- 阶段一：TCP 扫描 ----
  session.phase = 'tcp' as TestPhase;
  addLog(session, `阶段一：TCP 延迟扫描启动，共 ${nodes.length} 个节点，并发 ${params.tcpConcurrency}，超时 ${params.tcpTimeoutMs}ms`);
  broadcastSSE(session.id, 'phase', { phase: 'tcp', total: nodes.length });

  const tcpGen = batchTcpProbe(
    nodes,
    params.tcpConcurrency,
    params.tcpTimeoutMs,
    (done, total, currentCount) => {
      session.tcpDone = done;
      broadcastSSE(session.id, 'tcp-progress', {
        done,
        total,
        currentCount,
      });
    },
  );

  for await (const result of tcpGen) {
    if ((session.phase as string) === 'cancelled') break;
    session.tcpResults.push(result);
    if (!result.success) {
      session.tcpFailed++;
    }
    broadcastSSE(session.id, 'tcp-result', result);
  }

  if ((session.phase as string) === 'cancelled') {
    addLog(session, '测速已取消');
    broadcastSSE(session.id, 'done', {
      status: 'cancelled',
      tcpDone: session.tcpDone,
      tcpFailed: session.tcpFailed,
      downloadDone: session.downloadDone,
      downloadFailed: session.downloadFailed,
    });
    return;
  }

  addLog(
    session,
    `TCP 扫描完成：成功 ${session.tcpDone - session.tcpFailed} 个，失败 ${session.tcpFailed} 个`,
  );

  // ---- 筛选候选 ----
  const candidates = selectCandidates(session.tcpResults, params.topPerCountry);
  session.downloadTotal = candidates.length;
  addLog(
    session,
    `筛选出 ${candidates.length} 个低延迟候选节点进入下载测速阶段`,
  );
  broadcastSSE(session.id, 'candidates-selected', {
    count: candidates.length,
  });

  // ---- 阶段二：下载测速 ----
  session.phase = 'download' as TestPhase;
  addLog(
    session,
    `阶段二：下载测速启动，并发 ${params.downloadConcurrency}，超时 ${params.downloadTimeoutMs}ms`,
  );
  broadcastSSE(session.id, 'phase', {
    phase: 'download',
    total: candidates.length,
  });

  const dlGen = batchDownloadTest(
    candidates,
    params.downloadConcurrency,
    params.downloadTimeoutMs,
    256 * 1024,
    (done, total, currentIps) => {
      session.downloadDone = done;
      session.currentIps = currentIps;
      broadcastSSE(session.id, 'download-progress', {
        done,
        total,
        currentIps,
      });
    },
  );

  for await (const result of dlGen) {
    if ((session.phase as string) === 'cancelled') break;
    session.speedResults.push(result);
    if (!result.success) {
      session.downloadFailed++;
    }
    broadcastSSE(session.id, 'download-result', result);
  }

  if ((session.phase as string) === 'cancelled') {
    addLog(session, '测速已取消');
    broadcastSSE(session.id, 'done', {
      status: 'cancelled',
      tcpDone: session.tcpDone,
      tcpFailed: session.tcpFailed,
      downloadDone: session.downloadDone,
      downloadFailed: session.downloadFailed,
    });
    return;
  }

  session.phase = 'done';
  const successCount = session.downloadDone - session.downloadFailed;
  const highSpeedCount = session.speedResults.filter(
    (r) => r.success && r.speed >= params.minSpeedMbps,
  ).length;
  addLog(
    session,
    `测速完成：成功 ${successCount} 个，失败 ${session.downloadFailed} 个，高速 (≥${params.minSpeedMbps}Mbps) ${highSpeedCount} 个`,
  );
  broadcastSSE(session.id, 'done', {
    status: 'done',
    total: session.total,
    tcpDone: session.tcpDone,
    tcpFailed: session.tcpFailed,
    downloadTotal: session.downloadTotal,
    downloadDone: session.downloadDone,
    downloadFailed: session.downloadFailed,
    highSpeedCount,
  });

  // 10 分钟后清理会话
  setTimeout(() => {
    sessions.delete(session.id);
    sseConnections.delete(session.id);
  }, 10 * 60 * 1000);
}

// ---- 解析自定义节点列表 ----
function parseCustomIpList(text: string): {
  ip: string;
  port: number;
  code: string;
  city: string;
  country: string;
  latency: number;
}[] {
  const lines = text
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const result: {
    ip: string;
    port: number;
    code: string;
    city: string;
    country: string;
    latency: number;
  }[] = [];

  for (const line of lines) {
    // 支持格式: ip 或 ip:port
    let ip = line;
    let port = 443;
    if (line.includes(':')) {
      const parts = line.split(':');
      ip = parts[0];
      const p = parseInt(parts[1], 10);
      if (!isNaN(p)) port = p;
    }
    // 验证 IPv4 格式
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) continue;
    result.push({
      ip,
      port,
      code: 'CUST',
      city: '自定义',
      country: 'CUSTOM',
      latency: 0,
    });
  }
  return result;
}

// ---- HTTP Server ----

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // GET /api/nodes - 内置节点元数据
  if (url.pathname === '/api/nodes' && req.method === 'GET') {
    const countries = Array.from(new Set(BUILTIN_NODES.map((n) => n.country)));
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        total: BUILTIN_NODES.length,
        countries,
      }),
    );
    return;
  }

  // POST /api/test/start - 启动两阶段测速
  if (url.pathname === '/api/test/start' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let params: Partial<ITestParams> & { customIps?: string } = {};
      try {
        params = body ? JSON.parse(body) : {};
      } catch {
        // 忽略
      }

      const testParams: ITestParams = {
        tcpTimeoutMs: Math.min(10000, Math.max(200, params.tcpTimeoutMs ?? 1500)),
        tcpConcurrency: Math.min(2000, Math.max(10, params.tcpConcurrency ?? 500)),
        downloadTimeoutMs: Math.min(30000, Math.max(1000, params.downloadTimeoutMs ?? 6000)),
        downloadConcurrency: Math.min(200, Math.max(1, params.downloadConcurrency ?? 16)),
        minSpeedMbps: Math.max(0.1, params.minSpeedMbps ?? 8.0),
        topPerCountry: Math.min(50, Math.max(1, params.topPerCountry ?? 4)),
      };

      // 确定节点数据源
      let nodes = BUILTIN_NODES;
      if (params.customIps && params.customIps.trim()) {
        const custom = parseCustomIpList(params.customIps);
        if (custom.length > 0) {
          nodes = custom;
        }
      }

      const session: ITestSession = {
        id: genSessionId(),
        params: testParams,
        phase: 'tcp',
        total: nodes.length,
        tcpDone: 0,
        tcpFailed: 0,
        downloadTotal: 0,
        downloadDone: 0,
        downloadFailed: 0,
        currentIps: [],
        tcpResults: [],
        speedResults: [],
        log: [],
      };
      sessions.set(session.id, session);
      sseConnections.set(session.id, new Set());

      addLog(session, `测速任务创建，节点数：${nodes.length}`);

      // 异步启动
      runTwoPhaseTest(session, nodes).catch((err) => {
        addLog(session, `测速异常：${String(err.message ?? err)}`);
        session.phase = 'done';
        broadcastSSE(session.id, 'done', {
          status: 'error',
          error: String(err.message ?? err),
        });
      });

      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          sessionId: session.id,
          total: session.total,
          params: testParams,
        }),
      );
    });
    return;
  }

  // GET /api/test/stream/:sessionId - SSE 订阅
  if (url.pathname.startsWith('/api/test/stream/') && req.method === 'GET') {
    const sessionId = url.pathname.slice('/api/test/stream/'.length);
    const session = sessions.get(sessionId);
    if (!session) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'session not found' }));
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const conns = sseConnections.get(sessionId)!;
    conns.add(res);

    // 补发当前状态
    sendSSE(res, 'phase', { phase: session.phase, total: session.total });
    if (session.tcpDone > 0) {
      sendSSE(res, 'tcp-progress', {
        done: session.tcpDone,
        total: session.total,
        currentCount: 0,
      });
    }
    if (session.downloadDone > 0) {
      sendSSE(res, 'download-progress', {
        done: session.downloadDone,
        total: session.downloadTotal,
        currentIps: session.currentIps,
      });
    }
    // 补发日志
    if (session.log.length > 0) {
      sendSSE(res, 'log-batch', { messages: session.log.slice(-50) });
    }
    if (session.phase === 'done' || session.phase === 'cancelled') {
      const successCount = session.speedResults.filter((r) => r.success).length;
      const highSpeedCount = session.speedResults.filter(
        (r) => r.success && r.speed >= session.params.minSpeedMbps,
      ).length;
      sendSSE(res, 'done', {
        status: session.phase,
        total: session.total,
        tcpDone: session.tcpDone,
        tcpFailed: session.tcpFailed,
        downloadTotal: session.downloadTotal,
        downloadDone: session.downloadDone,
        downloadFailed: session.downloadFailed,
        successCount,
        highSpeedCount,
      });
    }

    req.on('close', () => {
      conns.delete(res);
    });
    return;
  }

  // POST /api/test/cancel/:sessionId - 取消测速
  if (url.pathname.startsWith('/api/test/cancel/') && req.method === 'POST') {
    const sessionId = url.pathname.slice('/api/test/cancel/'.length);
    const session = sessions.get(sessionId);
    if (!session) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'session not found' }));
      return;
    }
    if (session.phase === 'tcp' || session.phase === 'download') {
      session.phase = 'cancelled';
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        status: session.phase,
        tcpDone: session.tcpDone,
        downloadDone: session.downloadDone,
      }),
    );
    return;
  }

  // GET /api/test/result/:sessionId - 获取完整结果
  if (url.pathname.startsWith('/api/test/result/') && req.method === 'GET') {
    const sessionId = url.pathname.slice('/api/test/result/'.length);
    const session = sessions.get(sessionId);
    if (!session) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'session not found' }));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        sessionId: session.id,
        status: session.phase,
        params: session.params,
        total: session.total,
        tcpDone: session.tcpDone,
        tcpFailed: session.tcpFailed,
        downloadTotal: session.downloadTotal,
        downloadDone: session.downloadDone,
        downloadFailed: session.downloadFailed,
        tcpResults: session.tcpResults.slice(0, 100), // 限制数量避免过大
        speedResults: session.speedResults,
      }),
    );
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'not found' }));
});

const PORT = Number(process.env.SERVER_PORT ?? 8002);
const HOST = process.env.SERVER_HOST ?? '0.0.0.0';

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] Two-phase speed test API listening on ${HOST}:${PORT}`);
});
