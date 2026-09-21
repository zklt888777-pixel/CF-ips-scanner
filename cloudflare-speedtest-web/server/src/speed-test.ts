// EXPORTS: ITcpResult, ISpeedTestResult, tcpProbe, testNodeDownloadSpeed, batchTcpProbe, batchDownloadTest
import https from 'node:https';
import net from 'node:net';
import http from 'node:http';
import { performance } from 'node:perf_hooks';

export interface ITcpResult {
  ip: string;
  port: number;
  code: string;
  city: string;
  country: string;
  refLatency: number;
  tcpLatency: number; // TCP 握手延迟（ms），-1 表示失败
  success: boolean;
  error?: string;
}

export interface ISpeedTestResult {
  ip: string;
  port: number;
  code: string;
  city: string;
  country: string;
  refLatency: number;
  tcpLatency: number; // TCP 握手延迟参考
  latency: number; // 完整连接延迟（ms），-1 表示失败
  speed: number; // 下载速度（Mbps），-1 表示失败
  success: boolean;
  error?: string;
}

interface INodeBase {
  ip: string;
  port: number;
  code: string;
  latency: number;
  city: string;
  country: string;
}

/**
 * 阶段一：TCP 快速探测
 * 仅测量 TCP 握手延迟，不做 TLS 和 HTTP，非常快
 */
export function tcpProbe(
  node: INodeBase,
  timeoutMs = 1500,
): Promise<ITcpResult> {
  return new Promise((resolve) => {
    const base: ITcpResult = {
      ip: node.ip,
      port: node.port,
      code: node.code,
      city: node.city,
      country: node.country,
      refLatency: node.latency,
      tcpLatency: -1,
      success: false,
    };

    let settled = false;
    const startTime = performance.now();

    const finish = (override?: Partial<ITcpResult>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...base, ...override });
    };

    const timer = setTimeout(() => {
      finish({ error: 'timeout' });
    }, timeoutMs);

    const socket = net.createConnection(
      { host: node.ip, port: node.port, noDelay: true },
      () => {
        const elapsed = performance.now() - startTime;
        clearTimeout(timer);
        finish({
          tcpLatency: Math.round(elapsed),
          success: true,
        });
      },
    );

    socket.on('error', (err) => {
      clearTimeout(timer);
      finish({ error: String(err.message ?? err) });
    });

    socket.on('close', () => {
      // 如果正常完成已经 settled，这里不需要处理
    });
  });
}

/**
 * 阶段二：真实 HTTPS 下载测速
 * 测量连接延迟（TCP+TLS+首字节）和下载速度（Mbps）
 * 绕过证书校验（Cloudflare 证书域名与 IP 不匹配）
 */
export function testNodeDownloadSpeed(
  node: INodeBase & { tcpLatency: number },
  timeoutMs = 6000,
  maxBytes = 256 * 1024, // 最多下载 256KB 用于测速
): Promise<ISpeedTestResult> {
  return new Promise((resolve) => {
    const base: ISpeedTestResult = {
      ip: node.ip,
      port: node.port,
      code: node.code,
      city: node.city,
      country: node.country,
      refLatency: node.latency,
      tcpLatency: node.tcpLatency,
      latency: -1,
      speed: -1,
      success: false,
    };

    let settled = false;
    const startTime = performance.now();
    let firstByteTime = -1;
    let totalBytes = 0;

    const finish = (override?: Partial<ISpeedTestResult>) => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve({ ...base, ...override });
    };

    const timer = setTimeout(() => {
      // 超时如果已经收到了部分数据，用已有数据计算速度
      if (totalBytes > 0 && firstByteTime > 0) {
        const elapsed = (performance.now() - startTime) / 1000;
        const speedMbps = (totalBytes * 8) / 1000 / 1000 / elapsed;
        finish({
          latency: Math.round(firstByteTime),
          speed: Math.round(speedMbps * 100) / 100,
          success: true,
        });
      } else {
        finish({ error: 'timeout' });
      }
    }, timeoutMs);

    // 测速文件：选择 Cloudflare 任意 CDN 资源
    // 用 /cdn-cgi/trace 文本文件，小而快
    const req = https.get(
      {
        host: node.ip,
        port: node.port,
        path: '/cdn-cgi/trace',
        method: 'GET',
        rejectUnauthorized: false,
        servername: 'cloudflare.com',
        headers: {
          Host: 'cloudflare.com',
          'User-Agent':
            'Mozilla/5.0 (compatible; NodeSpeedTest/2.0)',
          Accept: '*/*',
          Connection: 'close',
        },
        minVersion: 'TLSv1.2',
      },
      (res) => {
        firstByteTime = performance.now() - startTime;

        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          // 达到下载上限就结束，避免长时间下载
          if (totalBytes >= maxBytes) {
            res.destroy();
            const elapsed = (performance.now() - startTime) / 1000;
            const speedMbps = (totalBytes * 8) / 1000 / 1000 / elapsed;
            clearTimeout(timer);
            finish({
              latency: Math.round(firstByteTime),
              speed: Math.round(speedMbps * 100) / 100,
              success: true,
            });
          }
        });

        res.on('end', () => {
          const elapsed = (performance.now() - startTime) / 1000;
          const speedMbps =
            totalBytes > 0
              ? (totalBytes * 8) / 1000 / 1000 / elapsed
              : -1;
          clearTimeout(timer);
          finish({
            latency: Math.round(firstByteTime),
            speed: speedMbps > 0 ? Math.round(speedMbps * 100) / 100 : -1,
            success: totalBytes > 0,
            error: totalBytes > 0 ? undefined : 'empty-response',
          });
        });

        res.on('error', (err) => {
          clearTimeout(timer);
          // 有首字节但数据下载出错，用已有数据计算
          if (firstByteTime > 0 && totalBytes > 0) {
            const elapsed = (performance.now() - startTime) / 1000;
            const speedMbps = (totalBytes * 8) / 1000 / 1000 / elapsed;
            finish({
              latency: Math.round(firstByteTime),
              speed: Math.round(speedMbps * 100) / 100,
              success: true,
            });
          } else {
            finish({ error: String(err.message ?? err) });
          }
        });
      },
    );

    req.on('error', () => {
      clearTimeout(timer);
      // https 失败，尝试 http 兜底
      tryHttpFallback(node, timeoutMs, maxBytes, base, startTime, (r) => {
        if (settled) return;
        settled = true;
        resolve(r);
      });
    });

    req.end();
  });
}

/**
 * HTTP 兜底测速
 */
function tryHttpFallback(
  node: INodeBase & { tcpLatency: number },
  timeoutMs: number,
  maxBytes: number,
  base: ISpeedTestResult,
  _startTime: number,
  done: (r: ISpeedTestResult) => void,
) {
  const t0 = performance.now();
  let firstByte = -1;
  let bytes = 0;
  let finished = false;

  const timer = setTimeout(() => {
    if (!finished) {
      finished = true;
      req.destroy();
      if (bytes > 0 && firstByte > 0) {
        const elapsed = (performance.now() - t0) / 1000;
        const speedMbps = (bytes * 8) / 1000 / 1000 / elapsed;
        done({
          ...base,
          latency: Math.round(firstByte),
          speed: Math.round(speedMbps * 100) / 100,
          success: true,
        });
      } else {
        done({ ...base, error: 'http-timeout' });
      }
    }
  }, timeoutMs);

  const req = http.get(
    {
      host: node.ip,
      port: 80,
      path: '/cdn-cgi/trace',
      method: 'GET',
      headers: {
        Host: 'cloudflare.com',
        'User-Agent': 'Mozilla/5.0 (compatible; NodeSpeedTest/2.0)',
        Connection: 'close',
      },
      timeout: timeoutMs,
    },
    (res) => {
      firstByte = performance.now() - t0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes >= Math.min(maxBytes, 64 * 1024)) {
          res.destroy();
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          const elapsed = (performance.now() - t0) / 1000;
          const speedMbps = (bytes * 8) / 1000 / 1000 / elapsed;
          done({
            ...base,
            latency: Math.round(firstByte),
            speed: Math.round(speedMbps * 100) / 100,
            success: true,
          });
        }
      });
      res.on('end', () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const elapsed = (performance.now() - t0) / 1000;
        const speedMbps =
          bytes > 0 ? (bytes * 8) / 1000 / 1000 / elapsed : -1;
        done({
          ...base,
          latency: Math.round(firstByte),
          speed: speedMbps > 0 ? Math.round(speedMbps * 100) / 100 : -1,
          success: bytes > 0,
          error: bytes > 0 ? undefined : 'http-empty',
        });
      });
      res.on('error', () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        done({ ...base, error: 'http-failed' });
      });
    },
  );

  req.on('error', () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    done({ ...base, error: 'http-connect-failed' });
  });

  req.end();
}

/**
 * 并发控制批量 TCP 探测
 */
export async function* batchTcpProbe(
  nodes: INodeBase[],
  concurrency = 500,
  timeoutMs = 1500,
  onProgress?: (done: number, total: number, currentCount: number) => void,
): AsyncGenerator<ITcpResult, void, unknown> {
  const total = nodes.length;
  let doneCount = 0;
  let index = 0;
  const running = new Set<Promise<ITcpResult>>();

  function launchNext(): Promise<ITcpResult> | null {
    if (index >= total) return null;
    const node = nodes[index++];
    const p = tcpProbe(node, timeoutMs).then((r) => {
      doneCount++;
      onProgress?.(doneCount, total, running.size);
      return r;
    });
    running.add(p);
    return p;
  }

  // 初始填充
  for (let i = 0; i < concurrency && index < total; i++) {
    launchNext();
  }

  while (running.size > 0) {
    const result = await Promise.race(
      Array.from(running).map((p) =>
        p.then((r) => {
          running.delete(p);
          return r;
        }),
      ),
    );
    yield result;
    if (index < total) {
      launchNext();
    }
  }
}

/**
 * 并发控制批量下载测速
 */
export async function* batchDownloadTest(
  nodes: (INodeBase & { tcpLatency: number })[],
  concurrency = 16,
  timeoutMs = 6000,
  maxBytes = 256 * 1024,
  onProgress?: (done: number, total: number, currentIps: string[]) => void,
): AsyncGenerator<ISpeedTestResult, void, unknown> {
  const total = nodes.length;
  let doneCount = 0;
  let index = 0;
  const running = new Set<Promise<ISpeedTestResult>>();
  const currentIps = new Set<string>();

  function launchNext(): Promise<ISpeedTestResult> | null {
    if (index >= total) return null;
    const node = nodes[index++];
    currentIps.add(node.ip);
    const p = testNodeDownloadSpeed(node, timeoutMs, maxBytes).then((r) => {
      doneCount++;
      currentIps.delete(node.ip);
      onProgress?.(doneCount, total, Array.from(currentIps));
      return r;
    });
    running.add(p);
    return p;
  }

  for (let i = 0; i < concurrency && index < total; i++) {
    launchNext();
  }

  while (running.size > 0) {
    const result = await Promise.race(
      Array.from(running).map((p) =>
        p.then((r) => {
          running.delete(p);
          return r;
        }),
      ),
    );
    yield result;
    if (index < total) {
      launchNext();
    }
  }
}
