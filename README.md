# dsh-plugin-dictdb

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![DSH Plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blue.svg)](https://github.com/deepseek-ai/deepseek-harness)

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 agent 在渗透任务中**自主检索本地字典库**——它自己判断该用目录字典还是子域字典、要快还是求全，然后把绝对路径直接喂给 ffuf / dirsearch / hydra。

这是 [dictdb](https://github.com/shadowke25/dictdb) 的 DSH 前端。dictdb 负责管字典，本插件负责让 agent 会用。

---

## 它解决什么

```
# 装之前
你：帮我 fuzz 这个目标的目录
agent：请问要用哪个字典？我需要一个 -w 参数
你：（切出去翻 dictdb，select，复制路径，贴回来）

# 装之后
你：帮我 fuzz 这个目标的目录
agent：→ dictdb_search(category="dir", tag="fast")    自己挑，不用问你
       → ffuf -w "/dicts/store/0001-admin变种.txt" -u https://target/FUZZ
```

省掉的不只是几次复制粘贴。**agent 不必再为了查字典而拿到 shell 权限**——查字典变成一次受约束的工具调用，而不是一条任意的命令行。

---

## 工具

三个**只读**工具：

| 工具 | 用途 |
|---|---|
| `dictdb_search` | 按分类 / 标签 / 关键词找字典，返回可直接使用的绝对路径 |
| `dictdb_show` | 预览某条字典的内容（强制限量，见[三重限量](#三重限量)） |
| `dictdb_info` | 某条字典的完整元数据：全文说明、来源、git 锚点、md5 |

**写入类操作刻意不暴露。** `add` / `update` / `delete` / `git pull` 都不注册成工具——dictdb 的 `link` 模式条目会直接修改你的原文件，这类操作留给人。

### agent 怎么知道该选哪个

`dictdb_search` 的 description 里带了选字典的知识，模型不需要额外提示：

- 目录爆破主力 → `category="dir"`（含 dirsearch、raft-large、top7000 等大表）
- 快速验证 → 加 `tag="fast"`
- 子域枚举 → `category="subdomain"`；公司资产加 `tag="company"`
- 服务弱口令 → `tag="service"`（MySQL/SSH/RDP/SMB 等 66 个服务，user/pass 成对）
- 安全设备默认凭据 → `tag="device"`
- 403 / 4xx 绕过 → `tag="403bypass"`
- JWT Secret、文件上传、中文用户名 → `tag="jwt"` / `"upload"` / `"chinese"`

---

## 安装

### 从 GitHub（推荐）

```sh
dsh plugin --profile <profile> add github:shadowke25/dsh-plugin-dictdb
```

> **无需构建授权。** 本包没有构建步骤——`lib/index.js` 就是源码，直接提交在仓库里。因此不存在 DSH 文档里提到的「git 安装拿到源码却没有 `lib/` 输出」问题，pnpm 也不会要求你为 `prepare` 脚本授权。
>
> 如果 pnpm 仍然索要授权（不同版本行为可能不同），按它打印的包键写进 profile 的 `pnpm-workspace.yaml` 即可：
>
> ```yaml
> allowBuilds:
>   dsh-plugin-dictdb: true
> ```

锁定版本：

```sh
dsh plugin --profile <profile> add github:shadowke25/dsh-plugin-dictdb#v0.1.0
```

### 从 tarball

```sh
dsh plugin --profile <profile> add ./dsh-plugin-dictdb-0.1.0.tgz
```

### 从本地目录

```sh
dsh plugin --profile <profile> add ./dsh-plugin-dictdb
```

---

## 配置（必读）

插件**不预置任何机器相关路径**，所以必须告诉它 dictdb 在哪。三种方式任选其一。

### 方式一：profile patch（推荐）

在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 追加：

```yaml
- id: dsh-plugin-dictdb
  name: dsh-plugin-dictdb
  config:
    dictdbPath: '/path/to/dictdb'
```

> ⚠️ patch 会**替换**整行 `config`，不是深合并——只改一个键时，也要把想保留的键一并写上。

### 方式二：环境变量

设置 `DICTDB_PATH` 指向 dictdb 项目根（含 `dictdb/` 包的那一层）。

### 方式三：复用 dictdb 自己的变量

如果你已经设了 `DICTDB_HOME`（dictdb 的数据根），插件会直接用它——在 dictdb 默认的单目录布局下数据根就是项目根，**这种情况下无需任何插件配置**。

**解析顺序**：`config.dictdbPath` → `DICTDB_PATH` → `DICTDB_HOME`

### 全部配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `dictdbPath` | `''` | dictdb 项目根。空 = 走环境变量 |
| `pythonPath` | `''` | 解释器。空 = 自动探测 `<dictdbPath>/.venv/{Scripts,bin}/python`，再回退 PATH 上的 `python` |
| `dataHome` | `''` | `DICTDB_HOME`。空 = 环境变量，再回退 `dictdbPath` |
| `timeoutMs` | `30000` | 单次调用硬上限（毫秒） |
| `defaultHead` | `20` | 模型未指定行数时的预览行数 |
| `maxHead` | `200` | 预览行数的绝对上限，**插件侧强制** |

---

## 环境要求

| 要求 | 说明 |
|---|---|
| **dictdb ≥ v1.5** | v1.5 起 `select` 默认输出 9 字段投影，token 消耗约为旧版的 43% |
| **Python ≥ 3.11** | dictdb 是纯标准库，任意解释器均可 |
| **`DICTDB_HOME` 可写** | dictdb 用 SQLite WAL 模式，且 `select` 会写 `last_search.json`（`@n` 选择器依赖它）。指向只读目录会报 `unable to open database file` |

dictdb 的安装见 [shadowke25/dictdb](https://github.com/shadowke25/dictdb)。

---

## 设计说明

### 为什么走子进程，而不是重新实现

dictdb 已经拥有字段投影、选择器语法和 JSON 信封。在 JS 侧重新实现会与 Python 侧静默漂移——不报错，只是结果悄悄过时，而 agent 会拿着过时结果继续干活。子进程边界保住单一事实来源。

### 为什么 stdio 重定向到文件而不是管道

受限沙箱下子进程无法打开命名管道，`spawn(..., { stdio: 'pipe' })` 会**在子进程启动前**就抛 `EPERM`。重定向到临时文件在所有沙箱模式下都可用（实测，见 [`scripts/probe-stdio.mjs`](scripts/probe-stdio.mjs)）。

### 三重限量

字典动辄几十万行，一次不限量的读取就能烧穿上下文。插件从三个方向堵：

1. **`maxHead` 钳制** —— 唯一能挡住模型显式传 `head=999999` 的机制。dictdb 自己的默认值挡不住这个。
2. **`--head 0` 逃生口封堵** —— dictdb ≥ v1.5 把 `0` 读作「全文」，插件把 `head` 钳到 `[1, maxHead]`，任何方向都出不去。
3. **预览标记** —— 模型未指定范围时，输出会注明「以下为默认前 N 行，并非完整内容」，避免把预览当成整个字典而误判字典够不够用。

> 插件**总是**显式传 `--head`，不依赖 dictdb 的默认值：一旦依赖，遇到没有该默认的版本就可能吐出整个文件。

### 领域错误 vs 基础设施故障

| 情况 | 行为 |
|---|---|
| 没搜到字典 | **正常结果**，返回放宽条件的提示 |
| `NOT_FOUND` / `VALIDATION` | **正常结果**，返回带错误码的文本 |
| 未配置 `dictdbPath` | **抛异常**，附可操作的修复说明 |
| `dictdbPath` 不存在 | **抛异常**，报出具体路径 |
| 解释器起不来 / 超时 / JSON 解析失败 / 被取消 | **抛异常** |

这条分界很重要：把「没找到」当成故障抛异常，会让 agent 以为环境坏了而反复重试，实际只是该换个关键词。

---

## 故障排查

**工具没出现** —— 先确认层在：

```sh
dsh --profile <profile> --dump-config | grep dictdb
```

层在但工具不在，说明插件加载失败，看 DSH 启动日志里 `dictdb` 相关条目。

**`dictdb 插件尚未配置`** —— 没找到 dictdb 项目根。按上面[配置](#配置必读)一节任选一种方式。

**`dictdbPath 不存在`** —— 配置的路径不对，报错里会带上具体路径。

**解释器启动失败** —— 显式指定：

```yaml
    pythonPath: '/path/to/dictdb/.venv/bin/python'
```

**`unable to open database file`** —— `DICTDB_HOME` 不可写，换一个可写目录。

**搜索返回的字段有 16 个而不是 9 个** —— 指向了 dictdb v1.4 或更早的代码，升级到 v1.5+。

---

## 已知行为

`head` 传 `0` 或负数会被钳到 **1 行**。

这是安全方向的取舍：dictdb ≥ v1.5 把 `--head 0` 读作「全文」，插件必须堵死这条路，因此不做「0 = 不限制」的映射。工具 schema 里 `head` 是行数，正常调用不会传 0。

---

## 开发与测试

```sh
# 离线测试。需要一份可写的 DICTDB_HOME 副本
export DICTDB_TEST_PATH=/path/to/dictdb
export DICTDB_TEST_HOME=/path/to/writable/home
node --import ./scripts/stubs/register.mjs scripts/smoke.mjs
node --import ./scripts/stubs/register.mjs scripts/verify-description.mjs
```

| 脚本 | 作用 |
|---|---|
| `scripts/smoke.mjs` | 17 项行为断言 |
| `scripts/verify-description.mjs` | 逐个验证 description 里提到的 tag / 分类 / 具名大表**真的能命中** |
| `scripts/probe-stdio.mjs` | 实测沙箱下管道 `EPERM` 与文件重定向可用性 |

两个关键断言（`maxHead` 钳制、`head=0` 逃生口封堵）用 `maxHead=3` 的独立实例证明，不依赖夹具字典恰好够短：

```
maxHead=3 -> 3 rows
head=0 / -1 / 999999 / MAX_SAFE_INTEGER all capped at 3 rows
```

`verify-description.mjs` 的存在理由：description 是模型唯一的决策输入，写错一个 tag 就会把它引向死路。它走**真实消费路径**（`dictdb_search`）而不是手写聚合：

```
OK   tag=jwt            1 条   (JWT Secret)
OK   category=dir      71 条
OK   keyword=dirsearch  1 条
```

> `scripts/stubs/` 把 `@deepseek-ai/dsh-tools` 和 `@deepseek-ai/schemastery` 重定向到本地实现——这两个包由宿主从 `app.asar` 提供，裸 Node 进程无法解析。桩能验证定义形状符合文档，**不能替代一次真实加载**。

### 已在真实 DSH 中验证

装进 profile 后由 agent 实际调用：

- `dictdb_search` 返回 9 字段投影 + 绝对路径
- `dictdb_show` 默认 20 行并带截断标记
- `dictdb_show(head=999999)` 返回**恰好 `maxHead` 行**
- `dictdb_show(head=0)` 返回 1 行，未触及全文逃生口
- `dictdb_info` 返回完整 15 字段
- `@n` 选择器跨调用解析正确（依赖 `last_search.json`）

---

## 版本对应

插件依赖 dictdb 的 JSON 契约。**每次 dictdb 发版后建议跑一遍**：

```sh
node --import ./scripts/stubs/register.mjs scripts/verify-description.mjs
```

它会核对 description 里的每个筛选条件是否仍有命中。渲染层读的是字段名（`id` / `name` / `category` / `tags` / `instructions` / `lines` / `path` / `index` / `updated_at`）——如果 dictdb 改了名或删了字段，插件**不会报错**，只会静默渲染出空值或错位。这是唯一需要人工盯着的耦合点。

| 插件版本 | 对应 dictdb |
|---|---|
| `0.1.0` | `≥ 1.5.0` |

---

## License

[MIT](LICENSE) © shadowke25
