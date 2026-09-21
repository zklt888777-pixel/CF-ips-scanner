import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Copy,
  Check,
  Server,
  Globe,
  Zap,
  Play,
  Square,
  AlertCircle,
  Gauge,
  Download,
  Info,
  Settings,
  Terminal,
  ListFilter,
  FastForward,
  SignalHigh,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { copyToClipboard, scopedStorage } from '@lark-apaas/client-toolkit-lite';

import { MOCK_NODES } from '@/data/nodes';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Slider } from '@/components/ui/slider';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import {
  startSpeedTest,
  subscribeSpeedTest,
  checkBackendHealth,
  type INodeResult,
  type ITestParams,
} from '@/lib/speed-test-api';

const COUNTRY_NAMES: Record<string, string> = {
  US: '美国',
  SG: '新加坡',
  HK: '中国香港',
  PL: '波兰',
  IN: '印度',
  CUSTOM: '自定义',
};

type SortMode = 'speed' | 'latency';
type ViewMode = 'highSpeed' | 'allAvailable';
type DataSource = 'builtin' | 'custom';
type TestPhase = 'idle' | 'tcp' | 'download' | 'done' | 'cancelled';

interface ITopGroup {
  country: string;
  nodes: INodeResult[];
}

const DEFAULT_PARAMS: ITestParams = {
  tcpTimeoutMs: 1500,
  tcpConcurrency: 500,
  downloadTimeoutMs: 6000,
  downloadConcurrency: 16,
  minSpeedMbps: 8.0,
  topPerCountry: 4,
};

const STORAGE_PARAMS = 'node-speedtest:params';
const STORAGE_LAST_RESULTS = 'node-speedtest:last-results';
const STORAGE_CUSTOM_IPS = 'node-speedtest:custom-ips';

function formatNodeLine(node: INodeResult): string {
  const speedTxt = node.speed > 0 ? `-${node.speed.toFixed(2)}Mbps` : '';
  return `${node.ip}:${node.port}#${node.code}-${node.latency}ms-${node.city}-${node.country}${speedTxt}`;
}

function getTopNodesByCountry(
  nodes: INodeResult[],
  sortMode: SortMode,
  topN: number,
): ITopGroup[] {
  const successNodes = nodes.filter((n) => n.success);
  const groups = new Map<string, INodeResult[]>();
  for (const node of successNodes) {
    const list = groups.get(node.country) ?? [];
    list.push(node);
    groups.set(node.country, list);
  }

  const result: ITopGroup[] = [];
  for (const [country, list] of groups) {
    const sorted = [...list].sort((a, b) => {
      if (sortMode === 'speed') {
        return b.speed - a.speed;
      }
      return a.latency - b.latency;
    });
    result.push({
      country,
      nodes: sorted.slice(0, topN),
    });
  }

  result.sort((a, b) => {
    if (a.nodes.length === 0) return 1;
    if (b.nodes.length === 0) return -1;
    if (sortMode === 'speed') {
      return b.nodes[0].speed - a.nodes[0].speed;
    }
    return a.nodes[0].latency - b.nodes[0].latency;
  });
  return result;
}

export default function HomePage() {
  const [totalNodes, setTotalNodes] = useState(MOCK_NODES.length);
  const [phase, setPhase] = useState<TestPhase>('idle');
  const [sortMode, setSortMode] = useState<SortMode>('speed');
  const [viewMode, setViewMode] = useState<ViewMode>('highSpeed');
  const [dataSource, setDataSource] = useState<DataSource>('builtin');
  const [params, setParams] = useState<ITestParams>(DEFAULT_PARAMS);
  const [customIps, setCustomIps] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<string | null>(null);
  const [backendReady, setBackendReady] = useState<boolean | null>(null); // null=检测中

  // 测速进度
  const [tcpProgress, setTcpProgress] = useState({ done: 0, total: totalNodes });
  const [tcpFailed, setTcpFailed] = useState(0);
  const [downloadTotal, setDownloadTotal] = useState(0);
  const [downloadProgress, setDownloadProgress] = useState({ done: 0, total: 0, currentIps: [] as string[] });
  const [downloadFailed, setDownloadFailed] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);

  // 结果
  const [speedResults, setSpeedResults] = useState<INodeResult[]>([]);

  const sessionIdRef = useRef<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const isCancellingRef = useRef(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  // 加载缓存
  useEffect(() => {
    try {
      const cachedParams = scopedStorage.getItem(STORAGE_PARAMS);
      if (cachedParams) {
        setParams({ ...DEFAULT_PARAMS, ...JSON.parse(cachedParams) });
      }
      const cachedResults = scopedStorage.getItem(STORAGE_LAST_RESULTS);
      if (cachedResults) {
        const parsed = JSON.parse(cachedResults) as INodeResult[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          setSpeedResults(parsed);
          setPhase('done');
          const dlDone = parsed.length;
          const dlFailed = parsed.filter((r) => !r.success).length;
          setDownloadProgress({ done: dlDone, total: dlDone, currentIps: [] });
          setDownloadFailed(dlFailed);
          setDownloadTotal(dlDone);
        }
      }
      const cachedCustom = scopedStorage.getItem(STORAGE_CUSTOM_IPS);
      if (cachedCustom) {
        setCustomIps(cachedCustom);
      }
    } catch {
      // ignore
    }

    // 检测后端服务状态
    let mounted = true;
    async function check() {
      try {
        const ok = await checkBackendHealth();
        if (mounted) setBackendReady(ok);
      } catch {
        if (mounted) setBackendReady(false);
      }
    }
    check();
    // 每 5 秒重试一次（如果后端未就绪）
    const timer = setInterval(() => {
      if (backendReady === false) {
        check();
      }
    }, 5000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [backendReady]);

  // 保存参数到本地
  useEffect(() => {
    try {
      scopedStorage.setItem(STORAGE_PARAMS, JSON.stringify(params));
    } catch { /* ignore */ }
  }, [params]);

  // 保存自定义 IP
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        scopedStorage.setItem(STORAGE_CUSTOM_IPS, customIps);
      } catch { /* ignore */ }
    }, 500);
    return () => clearTimeout(timer);
  }, [customIps]);

  // 日志自动滚动
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollTop = logEndRef.current.scrollHeight;
    }
  }, [logs]);

  // 计算列表数据
  const displayNodes = useMemo(() => {
    if (viewMode === 'highSpeed') {
      return speedResults.filter(
        (r) => r.success && r.speed >= params.minSpeedMbps,
      );
    }
    return speedResults.filter((r) => r.success);
  }, [speedResults, viewMode, params.minSpeedMbps]);

  const topGroups = useMemo(
    () => getTopNodesByCountry(displayNodes, sortMode, params.topPerCountry),
    [displayNodes, sortMode, params.topPerCountry],
  );

  const topTotal = useMemo(
    () => topGroups.reduce((sum, g) => sum + g.nodes.length, 0),
    [topGroups],
  );

  const successCount = useMemo(
    () => speedResults.filter((r) => r.success).length,
    [speedResults],
  );

  const highSpeedCount = useMemo(
    () =>
      speedResults.filter(
        (r) => r.success && r.speed >= params.minSpeedMbps,
      ).length,
    [speedResults, params.minSpeedMbps],
  );

  // 总进度
  const overallPercent = useMemo(() => {
    if (phase === 'idle') return 0;
    if (phase === 'tcp') {
      // TCP 阶段占 40% 进度权重
      return totalNodes > 0 ? (tcpProgress.done / totalNodes) * 40 : 0;
    }
    if (phase === 'download') {
      // 下载阶段占 60%
      const tcpPart = 40;
      const dlPart =
        downloadTotal > 0 ? (downloadProgress.done / downloadTotal) * 60 : 0;
      return tcpPart + dlPart;
    }
    return 100;
  }, [phase, tcpProgress.done, totalNodes, downloadProgress.done, downloadTotal]);

  const isRunning = phase === 'tcp' || phase === 'download';

  // --- 测速控制 ---

  const handleStart = useCallback(async () => {
    if (isRunning) return;

    let nodeListText = '';
    if (dataSource === 'custom') {
      nodeListText = customIps.trim();
      if (!nodeListText) {
        toast.warning('请输入自定义 IP 列表');
        return;
      }
    }

    // 后端未就绪时提示
    if (backendReady === false) {
      toast.error('后端测速服务未启动，请检查服务是否正常运行（端口 8002）');
      return;
    }

    setPhase('tcp');
    setSpeedResults([]);
    setTcpFailed(0);
    setDownloadFailed(0);
    setDownloadTotal(0);
    setDownloadProgress({ done: 0, total: 0, currentIps: [] });
    setLogs([]);
    isCancellingRef.current = false;

    try {
      const { sessionId, total } = await startSpeedTest({
        ...params,
        customIps: dataSource === 'custom' ? customIps : undefined,
      });
      sessionIdRef.current = sessionId;
      setTotalNodes(total);
      setTcpProgress({ done: 0, total });

      const unsub = subscribeSpeedTest(sessionId, {
        onPhase: (p) => {
          setPhase(p as TestPhase);
        },
        onTcpProgress: (e) => {
          setTcpProgress({ done: e.done, total: e.total });
        },
        onTcpResult: () => {
          // 不单独存 TCP 结果，减少内存占用
        },
        onCandidatesSelected: (data) => {
          setDownloadTotal(data.count);
          setDownloadProgress((prev) => ({ ...prev, total: data.count }));
        },
        onDownloadProgress: (e) => {
          setDownloadProgress({
            done: e.done,
            total: e.total,
            currentIps: e.currentIps,
          });
        },
        onDownloadResult: (r) => {
          setSpeedResults((prev) => {
            const next = [...prev, r];
            // 每 100 条存一次缓存
            if (next.length % 100 === 0 || phase === 'done') {
              try {
                scopedStorage.setItem(
                  STORAGE_LAST_RESULTS,
                  JSON.stringify(next),
                );
              } catch { /* ignore */ }
            }
            return next;
          });
          if (!r.success) {
            setDownloadFailed((prev) => prev + 1);
          }
        },
        onLog: (msg) => {
          setLogs((prev) => [...prev, msg]);
        },
        onLogBatch: (messages) => {
          setLogs((prev) => [...prev, ...messages]);
        },
        onDone: (e) => {
          setPhase(e.status as TestPhase);
          if (e.status === 'done') {
            toast.success(
              `测速完成：成功 ${e.successCount ?? 0} 个，高速 ${e.highSpeedCount ?? 0} 个`,
            );
          } else if (e.status === 'cancelled') {
            toast.info('测速已取消');
          } else if (e.status === 'error') {
            toast.error(`测速异常：${e.error ?? '未知错误'}`);
          }
          // 最终保存
          setSpeedResults((prev) => {
            try {
              scopedStorage.setItem(
                STORAGE_LAST_RESULTS,
                JSON.stringify(prev),
              );
            } catch { /* ignore */ }
            return prev;
          });
          if (unsubscribeRef.current) {
            unsubscribeRef.current();
            unsubscribeRef.current = null;
          }
          sessionIdRef.current = null;
          isCancellingRef.current = false;
        },
        onError: (err) => {
          if (isRunning) {
            toast.error(`连接错误：${err}`);
          }
        },
      });
      unsubscribeRef.current = unsub;
    } catch (err) {
      setPhase('idle');
      toast.error(`启动失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [isRunning, params, dataSource, customIps, phase, backendReady]);

  const handleCancel = useCallback(async () => {
    if (!isRunning || !sessionIdRef.current || isCancellingRef.current) return;
    isCancellingRef.current = true;
    try {
      await import('@/lib/speed-test-api').then((m) =>
        m.cancelSpeedTest(sessionIdRef.current!),
      );
      toast.info('正在停止测速...');
    } catch {
      toast.error('取消失败');
      isCancellingRef.current = false;
    }
  }, [isRunning]);

  useEffect(() => {
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }
    };
  }, []);

  // --- 复制 ---

  const allLines = useMemo(() => {
    return topGroups
      .flatMap((g) => g.nodes.map((n) => formatNodeLine(n)))
      .join('\n');
  }, [topGroups]);

  async function handleCopyAll() {
    if (topTotal === 0) {
      toast.warning('暂无优选节点可复制');
      return;
    }
    try {
      await copyToClipboard(allLines);
      toast.success(`已复制 ${topTotal} 条优选节点`);
    } catch {
      toast.error('复制失败');
    }
  }

  async function handleCopyGroup(group: ITopGroup) {
    const text = group.nodes.map((n) => formatNodeLine(n)).join('\n');
    try {
      await copyToClipboard(text);
      toast.success(`已复制 ${group.country} 的 ${group.nodes.length} 条节点`);
    } catch {
      toast.error('复制失败');
    }
  }

  async function handleCopyOne(node: INodeResult, key: string) {
    try {
      await copyToClipboard(formatNodeLine(node));
      setCopiedIndex(key);
      toast.success(`已复制 ${node.ip}:${node.port}`);
      setTimeout(() => setCopiedIndex(null), 1500);
    } catch {
      toast.error('复制失败');
    }
  }

  const hasResults = speedResults.length > 0;

  function updateParam<K extends keyof ITestParams>(
    key: K,
    value: ITestParams[K],
  ) {
    setParams((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/10">
        <main className="space-y-6 md:space-y-8">
          {/* Header */}
          <header className="w-full bg-background/80 backdrop-blur-md border-b border-border/30 sticky top-0 z-50">
            <div className="max-w-7xl mx-auto px-4 md:px-6 flex h-16 items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="size-9 rounded-lg bg-primary text-primary-foreground flex items-center justify-center">
                  <Zap className="size-5" />
                </div>
                <div>
                  <h1 className="text-lg font-bold text-foreground leading-tight">
                    节点优选工具
                  </h1>
                  <p className="text-xs text-muted-foreground">
                    Cloudflare 两阶段真实测速
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {hasResults && (
                  <Button variant="secondary" onClick={handleCopyAll} className="gap-2">
                    <Copy className="size-4" />
                    复制全部优选
                  </Button>
                )}
                {isRunning ? (
                  <Button
                    variant="destructive"
                    onClick={handleCancel}
                    disabled={isCancellingRef.current}
                    className="gap-2"
                  >
                    <Square className="size-4" />
                    停止测速
                  </Button>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        onClick={handleStart}
                        disabled={backendReady === false}
                        className="gap-2"
                      >
                        <Play className="size-4" />
                        {hasResults ? '重新测速' : '开始测速'}
                      </Button>
                    </TooltipTrigger>
                    {backendReady === false && (
                      <TooltipContent>
                        后端测速服务未启动 (端口 8002)，请先启动服务
                      </TooltipContent>
                    )}
                    {backendReady === null && (
                      <TooltipContent>
                        正在检测后端服务状态...
                      </TooltipContent>
                    )}
                  </Tooltip>
                )}
              </div>
            </div>
          </header>

          <div className="max-w-7xl mx-auto px-4 md:px-6 grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* 左侧：参数面板 */}
            <aside className="lg:col-span-1 space-y-4">
              {/* 数据源 */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <ListFilter className="size-4" />
                    数据源
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Tabs
                    value={dataSource}
                    onValueChange={(v) => setDataSource(v as DataSource)}
                    className="w-full"
                  >
                    <TabsList className="w-full grid grid-cols-2">
                      <TabsTrigger value="builtin">内置节点</TabsTrigger>
                      <TabsTrigger value="custom">自定义</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  {dataSource === 'builtin' && (
                    <p className="text-xs text-muted-foreground">
                      内置 {MOCK_NODES.length.toLocaleString()} 条 Cloudflare 节点数据
                    </p>
                  )}
                  {dataSource === 'custom' && (
                    <Textarea
                      placeholder="粘贴 IP 列表，每行一个，支持 ip:port&#10;例如：&#10;1.1.1.1&#10;8.8.8.8:443"
                      className="h-40 font-mono text-xs resize-none"
                      value={customIps}
                      onChange={(e) => setCustomIps(e.target.value)}
                      disabled={isRunning}
                    />
                  )}
                </CardContent>
              </Card>

              {/* 测速参数 */}
              <Collapsible defaultOpen={!isRunning && !hasResults}>
                <Card>
                  <CardHeader className="pb-2">
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="sm" className="w-full justify-between p-0 h-auto">
                        <CardTitle className="text-base flex items-center gap-2">
                          <Settings className="size-4" />
                          测速参数
                        </CardTitle>
                        <span className="text-xs text-muted-foreground">展开/收起</span>
                      </Button>
                    </CollapsibleTrigger>
                  </CardHeader>
                  <CollapsibleContent>
                    <CardContent className="space-y-5 pt-2">
                      {/* TCP 超时 */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-foreground font-medium">TCP 超时</span>
                          <span className="text-muted-foreground tabular-nums">
                            {params.tcpTimeoutMs} ms
                          </span>
                        </div>
                        <Slider
                          value={[params.tcpTimeoutMs]}
                          onValueChange={([v]) => updateParam('tcpTimeoutMs', v)}
                          min={500}
                          max={5000}
                          step={100}
                          disabled={isRunning}
                        />
                        <p className="text-xs text-muted-foreground">单次 TCP 连接的超时时间</p>
                      </div>

                      <Separator />

                      {/* TCP 并发 */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-foreground font-medium">TCP 并发数</span>
                          <span className="text-muted-foreground tabular-nums">
                            {params.tcpConcurrency}
                          </span>
                        </div>
                        <Slider
                          value={[params.tcpConcurrency]}
                          onValueChange={([v]) => updateParam('tcpConcurrency', v)}
                          min={50}
                          max={1000}
                          step={50}
                          disabled={isRunning}
                        />
                        <p className="text-xs text-muted-foreground">并发 TCP 探测的数量</p>
                      </div>

                      <Separator />

                      {/* 测速超时 */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-foreground font-medium">测速超时</span>
                          <span className="text-muted-foreground tabular-nums">
                            {(params.downloadTimeoutMs / 1000).toFixed(1)} 秒
                          </span>
                        </div>
                        <Slider
                          value={[params.downloadTimeoutMs]}
                          onValueChange={([v]) => updateParam('downloadTimeoutMs', v)}
                          min={2000}
                          max={15000}
                          step={500}
                          disabled={isRunning}
                        />
                        <p className="text-xs text-muted-foreground">下载测速的超时时间</p>
                      </div>

                      <Separator />

                      {/* 测速并发 */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-foreground font-medium">测速并发数</span>
                          <span className="text-muted-foreground tabular-nums">
                            {params.downloadConcurrency}
                          </span>
                        </div>
                        <Slider
                          value={[params.downloadConcurrency]}
                          onValueChange={([v]) => updateParam('downloadConcurrency', v)}
                          min={4}
                          max={64}
                          step={2}
                          disabled={isRunning}
                        />
                        <p className="text-xs text-muted-foreground">并发下载测速的数量</p>
                      </div>

                      <Separator />

                      {/* 最低高速 */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-foreground font-medium">最低高速阈值</span>
                          <span className="text-muted-foreground tabular-nums">
                            {params.minSpeedMbps.toFixed(1)} Mbps
                          </span>
                        </div>
                        <Slider
                          value={[params.minSpeedMbps]}
                          onValueChange={([v]) => updateParam('minSpeedMbps', v)}
                          min={0.5}
                          max={50}
                          step={0.5}
                          disabled={isRunning}
                        />
                        <p className="text-xs text-muted-foreground">
                          低于此速度的 IP 不进入高速优选
                        </p>
                      </div>

                      <Separator />

                      {/* 每国候选数 */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-foreground font-medium">每国候选数</span>
                          <span className="text-muted-foreground tabular-nums">
                            {params.topPerCountry} 个
                          </span>
                        </div>
                        <Slider
                          value={[params.topPerCountry]}
                          onValueChange={([v]) => updateParam('topPerCountry', v)}
                          min={1}
                          max={20}
                          step={1}
                          disabled={isRunning}
                        />
                        <p className="text-xs text-muted-foreground">
                          每个国家保留的最快优选 IP 数量
                        </p>
                      </div>
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>

              {/* 日志 */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Terminal className="size-4" />
                    运行日志
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div
                    ref={logEndRef}
                    className="h-48 overflow-y-auto bg-foreground/5 p-3 text-xs font-mono text-muted-foreground space-y-0.5"
                  >
                    {logs.length === 0 ? (
                      <p className="text-muted-foreground/60">点击「开始测速」查看日志...</p>
                    ) : (
                      logs.map((line, i) => (
                        <div key={i} className="whitespace-pre-wrap break-all">
                          {line}
                        </div>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            </aside>

            {/* 右侧：主内容 */}
            <div className="lg:col-span-3 space-y-6">
              {/* 总进度 + 阶段 */}
              {isRunning && (
                <Card>
                  <CardContent className="p-5 space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {phase === 'tcp' ? (
                          <Badge variant="secondary" className="gap-1.5">
                            <FastForward className="size-3" />
                            阶段一 · TCP 延迟扫描
                          </Badge>
                        ) : (
                          <Badge className="gap-1.5 bg-primary/10 text-primary hover:bg-primary/15 border border-primary/20">
                            <Download className="size-3" />
                            阶段二 · 下载测速
                          </Badge>
                        )}
                        <span className="text-sm font-medium text-foreground tabular-nums">
                          {phase === 'tcp'
                            ? `${tcpProgress.done.toLocaleString()} / ${tcpProgress.total.toLocaleString()}`
                            : `${downloadProgress.done.toLocaleString()} / ${downloadProgress.total.toLocaleString()}`}
                        </span>
                        <Badge variant="outline" className="text-xs">
                          总体 {overallPercent.toFixed(1)}%
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Check className="size-3 text-success" />
                          成功 {phase === 'tcp'
                            ? tcpProgress.done - tcpFailed
                            : downloadProgress.done - downloadFailed}
                        </span>
                        <span className="flex items-center gap-1">
                          <AlertCircle className="size-3 text-destructive" />
                          失败 {phase === 'tcp' ? tcpFailed : downloadFailed}
                        </span>
                      </div>
                    </div>
                    <Progress value={overallPercent} className="h-2" />
                    {phase === 'download' &&
                      downloadProgress.currentIps.length > 0 && (
                        <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                          <span className="shrink-0">测速中：</span>
                          <span className="font-mono truncate">
                            {downloadProgress.currentIps.slice(0, 6).join(', ')}
                            {downloadProgress.currentIps.length > 6
                              ? ` 等 ${downloadProgress.currentIps.length} 个`
                              : ''}
                          </span>
                        </div>
                      )}
                  </CardContent>
                </Card>
              )}

              {/* 提示 */}
              {!isRunning && (
                <div className="flex items-start gap-3 text-sm text-muted-foreground bg-muted/40 border border-border/40 rounded-lg px-4 py-3">
                  <Info className="size-4 shrink-0 mt-0.5" />
                  <p>
                    两阶段测速：先高并发 TCP 扫描筛选低延迟节点，再对候选做真实 HTTPS
                    下载测速。结果受当前网络环境影响，仅供参考。
                  </p>
                </div>
              )}

              {/* 统计 */}
              {hasResults && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                  className="grid grid-cols-2 md:grid-cols-5 gap-3"
                >
                  <StatCard
                    icon={<Server className="size-4" />}
                    label="节点总数"
                    value={totalNodes.toLocaleString()}
                    color="primary"
                  />
                  <StatCard
                    icon={<FastForward className="size-4" />}
                    label="TCP 通过"
                    value={(totalNodes - tcpFailed).toLocaleString()}
                    color="secondary"
                  />
                  <StatCard
                    icon={<Check className="size-4" />}
                    label="测速成功"
                    value={successCount.toLocaleString()}
                    color="success"
                  />
                  <StatCard
                    icon={<AlertCircle className="size-4" />}
                    label="失败数"
                    value={downloadFailed.toLocaleString()}
                    color="destructive"
                  />
                  <StatCard
                    icon={<SignalHigh className="size-4" />}
                    label="高速优选"
                    value={highSpeedCount.toLocaleString()}
                    color="warning"
                  />
                </motion.div>
              )}

              {/* 结果视图切换 + 操作 */}
              {hasResults && (
                <Card>
                  <CardContent className="p-4 flex flex-wrap items-center justify-between gap-4">
                    <Tabs
                      value={viewMode}
                      onValueChange={(v) => setViewMode(v as ViewMode)}
                    >
                      <TabsList>
                        <TabsTrigger value="highSpeed" className="gap-1.5">
                          <Zap className="size-3.5" />
                          高速优选
                          <Badge variant="secondary" className="ml-1 text-xs h-5 px-1.5">
                            {highSpeedCount}
                          </Badge>
                        </TabsTrigger>
                        <TabsTrigger value="allAvailable" className="gap-1.5">
                          <Globe className="size-3.5" />
                          全部可用
                          <Badge variant="outline" className="ml-1 text-xs h-5 px-1.5">
                            {successCount}
                          </Badge>
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>

                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">排序：</span>
                        <div className="flex rounded-md border border-border">
                          <Button
                            variant={sortMode === 'speed' ? 'default' : 'ghost'}
                            size="sm"
                            className="rounded-none rounded-l-md gap-1.5 h-8"
                            onClick={() => setSortMode('speed')}
                          >
                            <Download className="size-3.5" />
                            速度
                          </Button>
                          <Button
                            variant={sortMode === 'latency' ? 'default' : 'ghost'}
                            size="sm"
                            className="rounded-none rounded-r-md gap-1.5 h-8 border-l border-border"
                            onClick={() => setSortMode('latency')}
                          >
                            <Gauge className="size-3.5" />
                            延迟
                          </Button>
                        </div>
                      </div>
                      <Button variant="secondary" size="sm" onClick={handleCopyAll} className="gap-2">
                        <Copy className="size-3.5" />
                        复制优选
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* 空状态 */}
              {!hasResults && !isRunning && (
                <Card>
                  <CardContent className="p-12 text-center">
                    <div className="mx-auto size-16 rounded-full bg-primary/10 text-primary flex items-center justify-center mb-4">
                      <Zap className="size-8" />
                    </div>
                    <h2 className="text-lg font-semibold text-foreground mb-2">
                      点击「开始测速」获取真实节点速度
                    </h2>
                    <p className="text-sm text-muted-foreground max-w-md mx-auto mb-4">
                      两阶段测速：TCP 延迟快速筛选 + HTTPS 真实下载测速
                    </p>
                    <div className="text-xs text-muted-foreground max-w-md mx-auto space-y-1">
                      <p>• 阶段一：高并发 TCP 握手探测，快速筛选低延迟节点</p>
                      <p>• 阶段二：对低延迟候选做真实下载测速，测量延迟与速度</p>
                    </div>
                    <Button onClick={handleStart} className="mt-6 gap-2">
                      <Play className="size-4" />
                      开始测速
                    </Button>
                  </CardContent>
                </Card>
              )}

              {/* 优选结果列表 */}
              {hasResults && topGroups.length > 0 && (
                <div className="space-y-4">
                  {topGroups.map((group, gi) => (
                    <motion.div
                      key={group.country}
                      initial={{ opacity: 0, y: 16 }}
                      whileInView={{ opacity: 1, y: 0 }}
                      viewport={{ once: true, margin: '-50px' }}
                      transition={{
                        duration: 0.4,
                        delay: gi * 0.04,
                        ease: [0.16, 1, 0.3, 1],
                      }}
                    >
                      <Card>
                        <CardHeader className="pb-3">
                          <div className="flex items-center justify-between">
                            <CardTitle className="flex items-center gap-3 text-base">
                              <Badge variant="secondary" className="text-sm px-3 py-1">
                                {group.country}
                              </Badge>
                              <span className="text-foreground">
                                {COUNTRY_NAMES[group.country] ?? group.country}
                              </span>
                              <span className="text-sm font-normal text-muted-foreground">
                                · {group.nodes.length} 个优选节点
                              </span>
                            </CardTitle>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="gap-2"
                              onClick={() => handleCopyGroup(group)}
                            >
                              <Copy className="size-4" />
                              复制本组
                            </Button>
                          </div>
                        </CardHeader>
                        <CardContent className="p-0">
                          <div className="w-full overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b border-border/40 bg-muted/30">
                                  <th className="text-left font-medium text-muted-foreground px-4 py-2.5 whitespace-nowrap w-[60px]">
                                    排名
                                  </th>
                                  <th className="text-left font-medium text-muted-foreground px-4 py-2.5 whitespace-nowrap w-[100px]">
                                    国家
                                  </th>
                                  <th className="text-left font-medium text-muted-foreground px-4 py-2.5 whitespace-nowrap">
                                    城市
                                  </th>
                                  <th className="text-left font-medium text-muted-foreground px-4 py-2.5 whitespace-nowrap">
                                    IP:端口
                                  </th>
                                  <th className="text-left font-medium text-muted-foreground px-4 py-2.5 whitespace-nowrap">
                                    实测延迟
                                  </th>
                                  <th className="text-left font-medium text-muted-foreground px-4 py-2.5 whitespace-nowrap">
                                    实测速度
                                  </th>
                                  <th className="text-right font-medium text-muted-foreground px-4 py-2.5 whitespace-nowrap w-[100px]">
                                    操作
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {group.nodes.map((node, idx) => {
                                  const key = `${group.country}-${idx}`;
                                  const isCopied = copiedIndex === key;
                                  const isHighSpeed =
                                    node.success && node.speed >= params.minSpeedMbps;
                                  return (
                                    <tr
                                      key={key}
                                      className="border-b border-border/30 last:border-0 hover:bg-muted/30 transition-colors"
                                    >
                                      <td className="px-4 py-3 text-muted-foreground tabular-nums">
                                        #{idx + 1}
                                      </td>
                                      <td className="px-4 py-3">
                                        <Badge variant="outline">{node.country}</Badge>
                                      </td>
                                      <td className="px-4 py-3">
                                        <span className="font-medium text-foreground">
                                          {node.city}
                                        </span>
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <span className="text-muted-foreground ml-2 text-xs cursor-help">
                                              {node.code}
                                            </span>
                                          </TooltipTrigger>
                                          <TooltipContent>
                                            数据标注延迟：{node.refLatency}ms（仅供参考）
                                          </TooltipContent>
                                        </Tooltip>
                                      </td>
                                      <td className="px-4 py-3 font-mono text-foreground">
                                        {node.ip}:{node.port}
                                      </td>
                                      <td className="px-4 py-3">
                                        <span
                                          className={`inline-flex items-center gap-1 tabular-nums font-semibold ${
                                            node.latency <= 180
                                              ? 'text-success'
                                              : node.latency <= 300
                                                ? 'text-warning'
                                                : 'text-destructive'
                                          }`}
                                        >
                                          {node.latency}ms
                                        </span>
                                      </td>
                                      <td className="px-4 py-3">
                                        <span
                                          className={`inline-flex items-center gap-1 tabular-nums font-semibold ${
                                            isHighSpeed
                                              ? 'text-success'
                                              : 'text-foreground'
                                          }`}
                                        >
                                          {node.speed > 0
                                            ? `${node.speed.toFixed(2)} Mbps`
                                            : '-'}
                                        </span>
                                      </td>
                                      <td className="px-4 py-3 text-right">
                                        <Button
                                          size="sm"
                                          variant={isCopied ? 'default' : 'ghost'}
                                          className="gap-1.5"
                                          onClick={() => handleCopyOne(node, key)}
                                        >
                                          {isCopied ? (
                                            <>
                                              <Check className="size-4" />
                                              已复制
                                            </>
                                          ) : (
                                            <>
                                              <Copy className="size-4" />
                                              复制
                                            </>
                                          )}
                                        </Button>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </CardContent>
                      </Card>
                    </motion.div>
                  ))}
                </div>
              )}

              {/* 无结果提示 */}
              {hasResults && topGroups.length === 0 && (
                <Card>
                  <CardContent className="p-8 text-center">
                    <AlertCircle className="mx-auto size-8 text-muted-foreground mb-3" />
                    <p className="text-muted-foreground">
                      {viewMode === 'highSpeed'
                        ? `暂无比 ${params.minSpeedMbps.toFixed(1)} Mbps 更快的节点，请降低「最低高速阈值」`
                        : '暂无可用节点'}
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>

          {/* Footer */}
          <footer className="w-full border-t border-border/30 py-6 mt-8">
            <div className="max-w-7xl mx-auto px-4 md:px-6 text-center text-sm text-muted-foreground">
              节点优选工具 · 两阶段真实测速 · TCP 扫描 + 下载测速
            </div>
          </footer>
        </main>
      </div>
    </TooltipProvider>
  );
}

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: 'primary' | 'secondary' | 'success' | 'destructive' | 'warning';
}

function StatCard({ icon, label, value, color }: StatCardProps) {
  const colorMap: Record<string, string> = {
    primary: 'bg-primary/10 text-primary',
    secondary: 'bg-secondary text-secondary-foreground',
    success: 'bg-success/10 text-success',
    destructive: 'bg-destructive/10 text-destructive',
    warning: 'bg-warning/10 text-warning',
  };
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div
          className={`size-9 rounded-lg flex items-center justify-center shrink-0 ${colorMap[color]}`}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground truncate">{label}</div>
          <div className="text-lg font-bold text-foreground tabular-nums truncate">
            {value}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
