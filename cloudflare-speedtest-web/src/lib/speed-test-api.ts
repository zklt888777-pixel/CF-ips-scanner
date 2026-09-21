// EXPORTS: INodeResult, ITestParams, IStartResponse, startSpeedTest, subscribeSpeedTest, cancelSpeedTest, getNodeMeta
// 两阶段测速服务 API 封装

export interface INodeResult {
  ip: string;
  port: number;
  code: string;
  city: string;
  country: string;
  refLatency: number;
  tcpLatency: number;
  latency: number; // -1 表示失败
  speed: number; // -1 表示失败，单位 Mbps
  success: boolean;
  error?: string;
}

export interface ITcpResult {
  ip: string;
  port: number;
  code: string;
  city: string;
  country: string;
  refLatency: number;
  tcpLatency: number;
  success: boolean;
  error?: string;
}

export interface ITestParams {
  tcpTimeoutMs: number;
  tcpConcurrency: number;
  downloadTimeoutMs: number;
  downloadConcurrency: number;
  minSpeedMbps: number;
  topPerCountry: number;
}

export interface IStartResponse {
  sessionId: string;
  total: number;
  params: ITestParams;
}

export interface IProgressEvent {
  done: number;
  total: number;
}

export interface ITcpProgressEvent extends IProgressEvent {
  currentCount: number;
}

export interface IDownloadProgressEvent extends IProgressEvent {
  currentIps: string[];
}

export interface IDoneEvent {
  status: string;
  total: number;
  tcpDone: number;
  tcpFailed: number;
  downloadTotal: number;
  downloadDone: number;
  downloadFailed: number;
  highSpeedCount?: number;
  successCount?: number;
  error?: string;
}

function getApiBase(): string {
  if (typeof window === 'undefined') return '/api';
  // 开发环境：后端服务独立端口（默认 3000，与 SERVER_PORT 环境变量一致）
  const hostname = window.location.hostname;
  const serverPort = 3000;
  return `http://${hostname}:${serverPort}/api`;
}

const API_BASE = getApiBase();

/**
 * 检查后端服务是否可用
 */
export async function checkBackendHealth(): Promise<boolean> {
  try {
    const resp = await fetch(`${API_BASE}/nodes`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function startSpeedTest(
  params: Partial<ITestParams> & { customIps?: string },
): Promise<IStartResponse> {
  const resp = await fetch(`${API_BASE}/test/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!resp.ok) {
    throw new Error(`启动测速失败: ${resp.status}`);
  }
  return resp.json();
}

export function subscribeSpeedTest(
  sessionId: string,
  handlers: {
    onPhase?: (phase: string, total: number) => void;
    onTcpProgress?: (e: ITcpProgressEvent) => void;
    onTcpResult?: (r: ITcpResult) => void;
    onCandidatesSelected?: (data: { count: number }) => void;
    onDownloadProgress?: (e: IDownloadProgressEvent) => void;
    onDownloadResult?: (r: INodeResult) => void;
    onLog?: (message: string) => void;
    onLogBatch?: (messages: string[]) => void;
    onDone?: (e: IDoneEvent) => void;
    onError?: (err: string) => void;
  },
): () => void {
  const es = new EventSource(`${API_BASE}/test/stream/${sessionId}`);

  es.addEventListener('phase', (evt: MessageEvent) => {
    try {
      const data = JSON.parse(evt.data) as { phase: string; total: number };
      handlers.onPhase?.(data.phase, data.total);
    } catch { /* ignore */ }
  });

  es.addEventListener('tcp-progress', (evt: MessageEvent) => {
    try {
      const data = JSON.parse(evt.data) as ITcpProgressEvent;
      handlers.onTcpProgress?.(data);
    } catch { /* ignore */ }
  });

  es.addEventListener('tcp-result', (evt: MessageEvent) => {
    try {
      const data = JSON.parse(evt.data) as ITcpResult;
      handlers.onTcpResult?.(data);
    } catch { /* ignore */ }
  });

  es.addEventListener('candidates-selected', (evt: MessageEvent) => {
    try {
      const data = JSON.parse(evt.data) as { count: number };
      handlers.onCandidatesSelected?.(data);
    } catch { /* ignore */ }
  });

  es.addEventListener('download-progress', (evt: MessageEvent) => {
    try {
      const data = JSON.parse(evt.data) as IDownloadProgressEvent;
      handlers.onDownloadProgress?.(data);
    } catch { /* ignore */ }
  });

  es.addEventListener('download-result', (evt: MessageEvent) => {
    try {
      const data = JSON.parse(evt.data) as INodeResult;
      handlers.onDownloadResult?.(data);
    } catch { /* ignore */ }
  });

  es.addEventListener('log', (evt: MessageEvent) => {
    try {
      const data = JSON.parse(evt.data) as { message: string };
      handlers.onLog?.(data.message);
    } catch { /* ignore */ }
  });

  es.addEventListener('log-batch', (evt: MessageEvent) => {
    try {
      const data = JSON.parse(evt.data) as { messages: string[] };
      handlers.onLogBatch?.(data.messages);
    } catch { /* ignore */ }
  });

  es.addEventListener('done', (evt: MessageEvent) => {
    try {
      const data = JSON.parse(evt.data) as IDoneEvent;
      handlers.onDone?.(data);
    } catch { /* ignore */ }
  });

  es.onerror = () => {
    handlers.onError?.('连接断开');
  };

  return () => {
    es.close();
  };
}

export async function cancelSpeedTest(sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/test/cancel/${sessionId}`, { method: 'POST' });
}

export async function getNodeMeta(): Promise<{
  total: number;
  countries: string[];
}> {
  const resp = await fetch(`${API_BASE}/nodes`);
  if (!resp.ok) throw new Error('获取节点数据失败');
  return resp.json();
}
