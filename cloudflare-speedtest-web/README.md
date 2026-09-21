# Cloudflare 节点优选工具

基于 Cloudflare 边缘网络的两阶段真实测速工具，支持 TCP 延迟探测与 HTTP 下载速率测试，快速筛选最优节点。

## 功能特性

- 🌐 **两阶段测速**：TCP 延迟扫描 + HTTP 下载速率测试
- 📍 **多国家节点**：覆盖 US / SG / HK / IN / PL 等 2600+ 节点
- 🎯 **智能筛选**：按国家分组优选，支持自定义筛选阈值
- 📊 **实时进度**：SSE 流式推送，实时展示测速进度与结果
- 📋 **一键复制**：快速复制优选节点 IP 列表
- ⚙️ **自定义参数**：支持超时时间、并发数、高速阈值等参数调节

## 技术栈

- **前端**：React 19 + TypeScript + Tailwind CSS 4 + Vite
- **后端**：Node.js + TypeScript (tsx)
- **UI 组件**：shadcn/ui (new-york 风格)
- **实时通信**：Server-Sent Events (SSE)
- **图标**：Lucide Icons

## 项目结构

```
├── src/                    # 前端源码
│   ├── components/         # 通用 UI 组件
│   │   ├── ui/             # shadcn/ui 组件库
│   │   ├── Layout.tsx      # 布局组件
│   │   └── ...
│   ├── pages/
│   │   └── HomePage/       # 首页（测速主页面）
│   ├── lib/                # 工具库
│   │   └── speed-test-api.ts  # 测速 API 封装
│   ├── data/               # 节点数据
│   │   └── nodes.json      # 2600+ Cloudflare 节点数据
│   ├── app.tsx             # 路由配置
│   └── index.tsx           # 入口文件
├── server/                 # 后端测速服务
│   ├── src/
│   │   ├── server.ts       # HTTP + SSE 服务
│   │   └── speed-test.ts   # 测速核心逻辑
│   ├── package.json
│   └── tsconfig.json
├── scripts/
│   └── build.sh            # 构建脚本
├── vite.config.ts          # Vite 配置
├── package.json            # 前端依赖
└── README.md
```

## 快速开始

### 前置要求

- Node.js >= 18
- npm >= 9

### 1. 安装依赖

```bash
# 安装前端依赖
npm install

# 安装后端依赖
cd server && npm install && cd ..
```

### 2. 启动后端测速服务

```bash
# 默认端口 3000
npx tsx server/src/server.ts

# 或指定端口和地址
SERVER_PORT=8002 SERVER_HOST=0.0.0.0 npx tsx server/src/server.ts
```

后端服务启动后，可通过 `http://localhost:3000/api/nodes` 验证是否正常。

### 3. 启动前端开发服务器

```bash
npm run dev
```

默认前端开发服务器运行在 8001 端口，访问 `http://localhost:8001`。

> 注意：开发环境下前端默认请求 `http://localhost:3000/api`。
> 如后端端口不同，请修改 `src/lib/speed-test-api.ts` 中的 `getApiBase()` 函数。

### 4. 生产构建

```bash
# 前端构建
npm run build

# 后端构建
cd server && npm run build && cd ..
```

## API 接口

### `GET /api/nodes`
获取节点元数据

**响应**：
```json
{
  "total": 2661,
  "countries": ["US", "PL", "SG", "HK", "IN"]
}
```

### `POST /api/test/start`
启动两阶段测速任务

**请求体**：
```json
{
  "tcpTimeout": 1.5,
  "tcpConcurrency": 10,
  "speedTestTimeout": 6,
  "speedTestConcurrency": 16,
  "minHighSpeedThreshold": 8,
  "perCountryCandidates": 4,
  "candidateRatio": 0.1,
  "customIps": "可选，自定义 IP 列表"
}
```

**响应**：
```json
{
  "sessionId": "st_1234567890_abcdef",
  "total": 2661,
  "params": { ... }
}
```

### `GET /api/test/stream/:sessionId`
SSE 订阅测速进度

事件类型：
| 事件名 | 说明 |
|--------|------|
| `tcp-progress` | TCP 扫描阶段进度 |
| `tcp-result` | 单个节点 TCP 测速结果 |
| `candidates-selected` | 候选节点选定（进入下载阶段） |
| `download-progress` | 下载测速阶段进度 |
| `download-result` | 单个节点下载测速结果 |
| `done` | 测速完成 |
| `error` | 测速异常 |

### `POST /api/test/cancel/:sessionId`
取消测速任务

### `GET /api/test/result/:sessionId`
获取完整测速结果数组

## 部署到 GitHub

1. 在 GitHub 创建新仓库
2. 将源码推送至仓库：
```bash
git init
git add .
git commit -m "Initial commit: Cloudflare speed test tool"
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

## 生产部署建议

### 使用 Nginx 反向代理

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # 前端静态文件
    location / {
        root /path/to/dist;
        try_files $uri $uri/ /index.html;
    }

    # 后端 API 代理
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # SSE 需要的配置
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
    }
}
```

### 使用 PM2 管理后端进程

```bash
npm install -g pm2
pm2 start dist/server.js --name speedtest-server
pm2 save
pm2 startup
```

## 注意事项

- 测速结果受本地网络环境、运营商路由策略影响，仅供参考
- 节点数据来源于 Cloudflare 公开边缘节点 IP 段
- 请合理控制并发数和测速频率，避免对目标节点造成过大压力
- 本工具仅用于网络质量测试，请遵守相关法律法规
