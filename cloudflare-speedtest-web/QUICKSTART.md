# 本地运行指南（macOS / Windows / Linux 通用）

本项目是纯 Node.js 技术栈，macOS、Windows、Linux 均可本地运行。以下以 macOS 为例，其他系统命令基本一致（Windows 请用 PowerShell 或 Git Bash）。

## 一、环境要求

- Node.js ≥ 18（推荐 LTS）
- npm ≥ 9

macOS 安装 Node.js：

```bash
brew install node
node -v   # 确认输出版本号即可
```

> 没有 Homebrew 可去 https://nodejs.org/ 下载 LTS 安装包。

## 二、获取代码

```bash
git clone https://github.com/zklt888777-pixel/CF-ips-scanner.git
cd CF-ips-scanner/cloudflare-speedtest-web
```

## 三、安装依赖

```bash
npm install
cd server && npm install && cd ..
```

> 国内网络慢可换镜像：`npm config set registry https://registry.npmmirror.com`

## 四、启动（两个终端窗口）

**终端 A — 后端测速服务（启动后保持运行，不要关闭）：**

```bash
SERVER_PORT=3000 npx tsx server/src/server.ts
```

看到 `listening on 0.0.0.0:3000` 即成功。

**终端 B — 前端页面：**

```bash
npm run dev
```

启动后终端会打印本地地址（默认 http://localhost:5173 或 8080，以实际显示为准），浏览器打开即可。

## 五、使用

1. 浏览器打开前端地址
2. 左侧面板可调节测速参数：TCP 超时、TCP 并发数、测速超时、测速并发数、最低高速阈值、每国候选数
3. 点击「开始测速」：先高并发 TCP 扫描全部节点，再对低延迟候选做真实下载测速
4. 「高速优选」= 速度达到阈值的节点（每国取前 N）；「全部可用」= 所有测通节点
5. 支持按速度/延迟排序，一键复制全部/单组/单条节点

## 六、说明

- 测速在**本机网络**真实发起，结果反映你当前网络到 Cloudflare 节点的实际速度，换网络环境结果会不同
- 节点数据内置 2661 条（US/SG/HK/PL/IN），也支持自定义 IP 列表
- 实测速度通过下载 Cloudflare 官方测速文件（`/__down?bytes=1048576`，1MB）计算得出

## 七、常见问题

| 现象 | 解决 |
|---|---|
| 页面打不开 | 确认终端 A 后端在跑、终端 B 前端在跑 |
| 点测速没反应 | 确认后端用 `SERVER_PORT=3000` 启动（前端固定连 3000） |
| 实测速度全是 "-" | 确认 `server/src/speed-test.ts` 中 path 是 `/__down?bytes=1048576`，Host 是 `speed.cloudflare.com` |
| 端口被占用 | 前端改 `npm run dev -- --port 8002`；后端 `SERVER_PORT=3001 SERVER_HOST=0.0.0.0 npx tsx server/src/server.ts` 并同步修改前端 `src/lib/speed-test-api.ts` 的 `serverPort` |
| 停止服务 | 对应终端窗口按 `Ctrl + C` |
