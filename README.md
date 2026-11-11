# 粉笔 CLI 刷题

一个在终端里刷粉笔题库的小工具。TypeScript 编写，界面用 Ink（React for CLI）渲染。

- **离线**：读取本地 `data/` 目录下的卷子 JSON，支持「整卷模拟」和「即时反馈」两种模式，不发任何网络请求。
- **联网**：首页的「快速练习」会调用粉笔的练习接口，由服务端即时组卷（固定 15 题），交卷后拉取解析。

三种模式中，前两种完全离线；第三种需要登录态。

---

## 应用场景

最常见的用法，是**上班时偷偷备考公务员/事业单位**：工位上开一个终端窗口，界面从头到尾就是纯文本，像在跑命令、看构建日志或翻文档，不会弹出题卡、不带动画、没有音效，旁边的人扫一眼也看不出你在做题。

这个场景下几个特性正好对得上：

- **整卷模拟、即时反馈完全离线**，不产生任何网络请求，断网、内网限制、代理抽风都不影响，用起来也不会在网关里留下请求记录。
- **快速练习会联网**，但一轮只有获取类目、创建练习、拉题面、交卷、拉解析这几个短请求，答完就停，不会持续挂连接或轮询。
- **15 题一轮**的体量适合碎片时间，午休、等编译、开会前的几分钟都能做一轮；随时 `Esc` 退出，离线两种模式的作答进度写在本地 `progress.json`，下次接着答。
- **公式和图表在终端里只显示 `[公式图]` / `[图]` 占位**，满屏都是等宽文字，反而比图形化界面更不显眼。

代价也要说清楚：

- 联网的快速练习每次开始都会在当前账号里新建一条练习记录，即使中途 `Esc` 退出、没有交卷，记录也会保留；`npm run sync -- --create` 同样会在账号里建练习（不加 `--create` 的批量同步只复用已有练习）。离线两种模式的交卷只写本地，不涉及账号。所以别用那种「没人会看」的账号，真被翻记录时解释不清。
- 公司电脑和公司网络的使用请遵守单位规定。工具只是工具，别让它替你背锅。

---

## 环境要求与安装

- **Node.js ≥ 22**（依赖内置的全局 `fetch` 和 `WebSocket`；登录脚本用 WebSocket 连接 Chrome DevTools 协议）。
- 主要用于 Windows（登录流程会探测 Windows 下的 Chrome 安装目录，并使用 `%LOCALAPPDATA%` 存放独立 profile）。

```bash
npm install
```

运行：

```bash
npm run login   # 首次使用联网功能前登录一次（可选）
npm run tui     # 启动终端界面
```

同步数据用 `npm run sync`，生成题库清单用 `npm run catalog`，见下文。

仓库里**不附带任何 Cookie、抓包记录或卷子数据**（`data/`、`verify/`、`.auth/` 都在 `.gitignore` 里）。新克隆后从零到能刷题的顺序：

```bash
npm install
npm run login      # 1. 打开独立 Chrome 窗口，手动登录一次
npm run catalog    # 2. 可选：生成题库清单 data/catalog.json（只读，不建练习）
npm run sync -- --label <labelId> --limit 3   # 3. 拉几套卷子到 data/（已有进行中练习才直读）
npm run tui        # 4. 启动；data/ 为空时也能用「快速练习（联网）」
```

离线两种模式需要先有 `data/`，否则首页只有快速练习可选。

---

## 三种模式

### 1. 整卷模拟（离线）

- 在首页选中 `data/` 下的一套卷子后进入。
- 按卷面顺序作答，Enter 提交并跳到下一题；最后一题按 Enter 即交卷。
- 交卷后从第 1 题开始逐题查看答案与解析，答案来自本地 JSON 的 `questions[].answer` / `solution`。
- 不需要登录，不发起网络请求。
- 作答进度写入根目录 `progress.json`（`paper.file → globalId → { picked, correct }`），下次进入会从第一道未答题继续。
- 如果该卷 `hasSolution = false`（还没交卷或同步时解析未取到），交卷后的解析页会显示补同步提示。

### 2. 即时反馈（离线）

- 同样读取本地卷子，但只抽取**有 `answer`** 的题，顺序随机打乱。
- 选好答案按 Enter 立即显示对错、正确答案、解析、考点与全站正确率。
- 卷子没有任何答案数据时，该模式在选择页显示为不可用。
- 完全离线，不需要登录。

### 3. 快速练习（联网）

- 首页第一项「快速练习（联网）」。
- 流程：
  1. `GET /activity/userexamcategory/getUserSelectedList` 读取你已选的考试类目（含 `examCategoryId` 和课程 `prefix`），默认高亮 `getCurrent` 那一项。**只影响这一轮练习，不会改动你在网页上的当前考试**：全程不会调用 `userexamcategory/change`。
  2. 上下键选类目、Enter 确认后，`POST /api/{prefix}/exercises?examcatid=…`，body 为 `type=3&exerciseTimeMode=2`，创建一轮快速练习。**会在账号里新建一条练习记录，题量由服务端决定，固定 15 题。**
  3. `getExercise` 取 `staticUrl` 里的 token、`submitUrl`、`updateUserAnswerUrl`，再用 `static/exercise` 拉题面。
  4. 答题时按 Enter 进入下一题；最后一题按 Enter 进入交卷确认，再按 Enter 才真正交卷。
  5. 交卷时先逐题上报作答（`incrUpdate`，`answer.type = 201`，`101` 会被服务端静默忽略），再 `submit`，最后拉 `static/solution` 与 `getMeta` 展示解析与全站正确率。
- 每个已选类目按它的第一门课程取 `prefix`（行测/职测等客观题课程）；如果某个类目创建失败（比如只有面试课程），会显示错误和当时的选择，`R` 可以重新选类目。
- 已选类目为空或接口异常时，自动退回原来的行为：直接用 `getCurrent` 的类目组卷，并在界面上说明原因。
- 中途按 Esc 返回不会交卷，这条练习会以未交卷状态留在账号里。
- 需要登录：Cookie 读取顺序见下文；未登录或登录失效时无法进入。
- 网络失败、交卷失败、解析拉取失败会分阶段给出提示：解析失败可以按 `R` 重试，也可以按 Enter 先不带解析查看；交卷失败按 `R` 重新交卷。

首页顶部会显示登录态：

- `登录态校验中…`
- `已登录：userid … · Cookie 来自 …`
- `登录已失效（HTTP 401/403/453 …）`，提示运行 `npm run login` 后按 `R` 重试
- `登录态校验失败（网络异常，不代表未登录）`
- `未登录（本地没有 Cookie）`

整卷模拟与即时反馈不受登录态影响。

---

## 清单（catalog）

`npm run catalog` 只读遍历分类树和每个分类下的试卷列表，生成 `data/catalog.json`。**全程只发 GET，不创建任何练习。**

- 分类树：`GET /api/{prefix}/subLabels`，递归读取 `childrenLabels`。
- 试卷列表：`GET /api/{prefix}/papers/v2?labelId=…&toPage=…&pageSize=…`，按 `pageInfo.totalPage` 翻页。
- 分页之间默认间隔 150ms，避免把账号打到异常。

```bash
npm run catalog                          # 全量
npm run catalog -- --label 2906          # 只遍历该分类及其子分类
npm run catalog -- --max-pages 3         # 每个分类最多拉 3 页
```

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--label <id>` | 无 | 只遍历指定分类及其子树 |
| `--max-pages <n>` | `0`（不限） | 每个分类最多翻几页；大分类先用它探规模 |
| `--page-size <n>` | `100` | 每页条数 |
| `--delay <ms>` | `150` | 分页请求间隔 |
| `--examcat <id>` | `1000134` | examcatid |
| `--prefix <p>` | `xingce` | 课程前缀 |
| `--out <file>` | `data/catalog.json` | 输出文件 |
| `--data-dir <dir>` | `data` | 扫描本地已同步卷子的目录 |
| `--cookies <file>` | `verify/cookies.json` | Cookie 文件；`FENBI_COOKIE` 优先 |

`catalog.json` 结构：

- `labels[]`：`id`、`name`、`path`（层级路径）、`paperCount`、`fetched`、`pages`、`truncated`、`error`。
- `papers[]`：`paperId`、`name`、`date`、`combineKey`、`questionCount`、`labelIds`、`labelPaths`、`exerciseKey`、`exerciseStatus`、`submitted`、`synced`、`localFile`。
- `stats`：分类数、卷子数、已同步数、有进行中练习数、已交卷数。
- `questionCount` 只有已同步的卷子能填：试卷列表接口本身不返回题量，未同步的为 `null`，不会为了题量去创建练习。
- 同一套卷可能出现在多个分类下，`papers` 按 `paperId` 去重，`labelIds` / `labelPaths` 合并；`stats.paperEntries` 是含重复的分类条目数。

全量会遍历整棵分类树，规模随账号和考试类目变化（通常是几十个分类、数千套卷子）；分页请求量也在百次量级。想少打可以用 `--label` 或 `--max-pages`。清单只是生成时的快照，仓库里不附带任何真实数据。

---

## 批量下载

从清单批量同步，默认**跳过已同步**、**绝不隐式创建练习**：

```bash
npm run sync -- --catalog --limit 5                 # 从 data/catalog.json 取前 5 套未同步的
npm run sync -- --catalog --label 1 --limit 5       # 按分类 id 筛选
npm run sync -- --catalog --category 国考 --limit 5 # 按分类名/层级路径筛选
npm run sync -- --catalog --only-exercise           # 只挑有进行中练习的卷
npm run sync -- --catalog --submitted --limit 20    # 只挑已交卷的卷（走试卷级解析，不建练习）
npm run sync -- --catalog --force --limit 1         # 已同步的也重拉
```

- 是否已同步在运行时重新扫描 `--out` 目录，按 `exerciseKey` 或 `paperId` 匹配，不只看清单里的旧状态。
- 没有 `exerciseKey` 的卷默认打印跳过；只有显式加 `--create` 才会调用「开始练习」。
- 已交卷的卷通常拿不到 `exerciseKey`（列表里 `exercise.key` 为 `null`），此时走试卷级解析：
  `papers/{paperId}` 取 `encodeCheckInfo` → `getPaperSolution?checkId=…&paperId=…` 拿 `staticUrl`
  → 下载 CDN 上的试卷解析（doc JSON，逐题题干、选项、答案、解析、材料、卷面树），转成 HTML 落盘。
  **全程只读，不创建任何练习。**
- 产物：普通卷 `data/<exerciseKey>.json`；已交卷卷 `data/paper_<paperId>.json`。

---

## 同步器

`npm run sync` 把粉笔的卷子抓成 `data/` 下的 JSON。常用命令：

```bash
# 1) 按练习 key 同步一套卷
npm run sync -- --paper <exerciseKey>

# 2) 按分类同步前 N 套（默认 3 套）
npm run sync -- --label 1 --limit 3

# 3) 已交卷的练习 getExercise 不可用时，用 static URL 里的 key 直接同步
npm run sync -- --token <staticUrl 里的 key>
```

语义：

- `--paper <exerciseKey>`：`getExercise` → 取 `staticUrl` 中的 token → `static/exercise` + `static/solution` + `getMeta`。
- `--label <labelId>`：拉取该分类的试卷列表，取前 `--limit` 套（默认 3）。**默认只同步账号里已有进行中练习（`exercise.key`）的卷，没有练习的卷会打印跳过提示，不会替你创建。**
- `--create`：只对批量模式（`--label` / `--catalog`）生效。给没有 `exercise.key` 的卷主动调用「开始练习」（`POST /api/{prefix}/exercises`，`type=1`），这会在账号里留下练习记录；不加该参数时一律跳过。
- `--token`：直接用 static key 同步。已交卷的练习不再提供 `static/exercise`，此时题面会从 `static/solution` 里还原。

其他参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--catalog [file]` | 关闭 | 从清单批量同步，默认 `data/catalog.json` |
| `--category <文字>` | 无 | 按分类名或层级路径筛选清单 |
| `--only-exercise` | 关闭 | 只同步已有 `exerciseKey` 的卷子 |
| `--submitted` | 关闭 | 只同步已交卷的卷子；没有 `exerciseKey` 时走 `getPaperSolution` 的试卷级解析 |
| `--force` | 关闭 | 已同步过的也重新拉取 |
| `--limit <n>` | `3` | 批量时最多处理几套 |
| `--out <dir>` | `data` | 输出目录 |
| `--cookies <file>` | `verify/cookies.json` | Cookie 文件；环境变量 `FENBI_COOKIE` 优先级更高 |
| `--examcat <id>` | `1000134` | examcatid（默认行测） |
| `--report` | 关闭 | 额外抓取 `getReport` 成绩报告 |
| `--help` | — | 打印用法 |

产物：

- 正常按练习 key 同步：`data/<exerciseKey>.json`
- 只给了 token 且没有 exerciseKey：`data/token_<token 前 10 位>.json`
- 已交卷但拿不到 exerciseKey（`--catalog --submitted`）：`data/paper_<paperId>.json`，`exerciseKey = null`

未交卷时 `static/solution` 会失败，此时只落题面，`hasSolution = false`，`solutionError` 记录失败原因。

---

## 登录机制

```bash
npm run login
```

工作方式：

1. 找到系统已安装的 Google Chrome（依次尝试 `CHROME_PATH`、Program Files、Program Files (x86)、`%LOCALAPPDATA%` 下的安装路径）。
2. 用**独立 profile** 启动 Chrome：`%LOCALAPPDATA%\fenbi-cli\chrome-profile`，并开一个随机端口的远程调试（CDP）。不会触碰你日常使用的 Chrome profile。
3. 依次尝试打开 `www.fenbi.com/spa/tiku/guide/catalog`、`fenbi.com/spa/tiku/guide/catalog`、`tiku.fenbi.com/`，失败则换下一个入口。
4. 你在 Chrome 窗口里自行完成登录（扫码或账号密码都行）。**脚本不接触账号、密码、验证码。**
5. 脚本每 3 秒通过 CDP 读取一次 Cookie，并用它请求 `GET /api/users/current` 校验；通过后写入 `.auth/cookies.json` 并关闭登录窗口（加 `--keep` 则保留窗口）。
6. 参数：`--keep` 保留窗口、`--port <n>` 指定 CDP 端口、`--help` 查看帮助。

Cookie 读取顺序（所有联网请求统一走这一处）：

```
FENBI_COOKIE 环境变量  >  .auth/cookies.json  >  verify/cookies.json
```

`.auth/` 已加入 `.gitignore`。

失效时的表现：

- `users/current` 返回 401 / 403 / 453（453 通常是「无效 DeviceSid」）视为登录失效。
- 首页显示「登录已失效」并提示重新运行 `npm run login`，按 `R` 重新校验。
- 网络层错误单独显示为「网络异常，不代表未登录」，避免误判。
- 本地三个来源都没有 Cookie 时显示「未登录」。
- 无论登录态如何，「整卷模拟」和「即时反馈」都能正常使用。

---

## 数据结构

`data/<exerciseKey>.json`（由同步器写出，TUI 只读；已交卷卷为 `data/paper_<paperId>.json`，结构相同）：

| 字段 | 说明 |
| --- | --- |
| `schemaVersion` | 数据格式版本，当前为 `1` |
| `syncedAt` | 同步时间（ISO 字符串） |
| `exerciseKey` | 练习 key；用 `--token` 或已交卷卷（试卷级解析）时为 `null` |
| `token` | `staticUrl` 里的 key（试卷级解析为 CDN 的解析 token） |
| `paper` | 试卷元信息：`--label` 模式来自分类列表，试卷级解析为 `{ id, name, date }`，否则 `null` |
| `sheetName` | 卷子名称 |
| `hasSolution` | 是否取到了逐题解析（试卷级解析固定为 `true`） |
| `solutionError` | 解析未取到时的错误信息 |
| `materials` | 材料数组：`{ id, globalId, content }`，`content` 为 HTML |
| `questions` | 题目数组，见下 |
| `card` | 卷面树，见下 |
| `report` | 仅 `--report` 时存在，为成绩报告原始数据 |

`questions[]` 字段：

| 字段 | 说明 |
| --- | --- |
| `globalId` | 题目全局 ID，与作答进度、解析、统计关联 |
| `id` | 题目 ID |
| `tikuPrefix` | 题库前缀 |
| `type` | 题型 |
| `content` | 题干 HTML |
| `accessories` | 附件数组，选项在 `accessories[0].options` |
| `options` | 选项 HTML 数组 |
| `optionsType` | 选项类型；`102` 表示多选 |
| `answer` | `{ choice, type }`，`choice` 是选项下标（`"0"` 表示 A，`"0,2"` 表示 A、C）；未交卷时为 `null` |
| `solution` | `{ content, source, keypoints: [{ id, name }] }`，`content` 为解析 HTML |
| `stats` | `{ wrongCount, totalCount, correctRatio }`，全站作答统计；取不到时为 `null` |

`card` 是卷面树，节点字段：

| 字段 | 说明 |
| --- | --- |
| `nodeType` | `1` 为章节节点，`2` 为题目节点 |
| `key` | 题目节点的 globalId |
| `name` | 章节名称 |
| `materialKeys` | 该题引用的材料 globalId 列表 |
| `children` | 子节点 |

TUI 用这棵树还原每道题所属章节和材料，材料正文从 `materials` 里按 `globalId` 取。

其他本地文件：

- `progress.json`：离线模式的作答进度。
- 环境变量 `FENBI_DATA_DIR`、`FENBI_PROGRESS` 可分别覆盖数据目录和进度文件路径。

---

## 快捷键

**首页**

| 键 | 作用 |
| --- | --- |
| ↑ / ↓ | 选择卷子或「快速练习」 |
| Enter | 进入 |
| R | 重新校验登录态 |
| Q | 退出 |

**卷子模式选择**

| 键 | 作用 |
| --- | --- |
| ↑ / ↓ | 选择模式 |
| Enter | 开始 |
| Esc | 返回首页 |
| Q | 退出 |

**整卷模拟 / 即时反馈（作答中）**

| 键 | 作用 |
| --- | --- |
| A–F | 选择选项（卷子选项多于 4 个时可用 E、F；多选可多次切换） |
| Enter | 整卷模拟：提交并下一题（最后一题交卷）；即时反馈：提交并看解析 |
| N / P | 下一题 / 上一题 |
| O | 把当前题导出为 `.tmp/question.html`，用系统默认浏览器打开（看原始图片与公式） |
| ↑ / ↓ | 滚动一行 |
| PgUp / PgDn | 翻页 |
| Esc | 返回上一级 |
| Q | 退出 |

**解析查看（交卷后 / 即时反馈揭示后）**

| 键 | 作用 |
| --- | --- |
| Enter | 下一题 |
| N / P | 下一题 / 上一题 |
| O | 用浏览器打开当前题（含答案、解析与原始图片） |
| ↑ / ↓、PgUp / PgDn | 滚动 |
| Esc | 返回上一级 |
| Q | 退出 |

**快速练习**

| 场景 | 键 | 作用 |
| --- | --- | --- |
| 选类目 | ↑ / ↓ | 在已选考试类目间移动（默认 `getCurrent` 那一项） |
| 选类目 | Enter | 用选中类目创建练习并开始 |
| 选类目 | Esc / Q | 返回 / 退出 |
| 创建页 | Enter | 创建练习并开始 |
| 创建页 | Esc / Q | 返回 / 退出 |
| 出错页 | R / Enter | 重试；还没创建练习时回到类目选择（已创建则沿用，不重复创建） |
| 答题中 | A–F | 选择选项 |
| 答题中 | Enter | 作答并下一题；最后一题进入交卷确认 |
| 答题中 | N / P | 下一题 / 上一题 |
| 答题中 / 解析页 | O | 把当前题导出为 `.tmp/question.html` 并用浏览器打开 |
| 答题中 | ↑ / ↓、PgUp / PgDn | 滚动 |
| 答题中 | Esc | 返回（不交卷） |
| 交卷确认 | Enter | 确认交卷 |
| 交卷确认 | Esc | 返回检查 |
| 交卷/解析出错 | R | 重试交卷或重试拉解析 |
| 解析出错 | Enter | 不加载解析，直接进入查看 |
| 解析页 | Enter / N | 下一题 |
| 解析页 | P | 上一题 |
| 解析页 | Esc | 完成并返回 |
| 任意 | Q | 退出 |

---

## 已知限制

- **解析只能在交卷后拿到**：未交卷时 `static/solution` 返回 `exercise is not submit`，只能同步到题面。
- **快速练习题量固定 15 题**，由服务端决定，客户端不传题量参数。
- **终端里公式与图表只显示占位符**：HTML 中的 `<img>` 会被转换成 `[公式图]` / `[图]`，不做 LaTeX 或图片还原。需要看真图时按 `O`：当前题会写成 `.tmp/question.html`（同名覆盖）并用系统默认浏览器打开，题面保留原始富文本，图片和公式直接引用原 URL（协议相对地址补 `https:`）。实测两个图片域名在无 referer 时返回 200；如果以后出现防盗链或 403，再考虑下载到本地缓存，目前没有做。
- **终端文本化会改写两类符号**：填空题的空 `<u>`（空白、`&nbsp;`、纯下划线）显示为 `＿＿＿＿＿` 可见横线，有真实内容的 `<u>` 用 `_内容_` 包裹；圈号 `①`–`⑳` 统一改成括号数字，单个写作 `(1)`，两个以上连续出现（排序题选项）用连字符连接，如 `③①⑤⑥②` → `3-1-5-6-2`。浏览器导出的 HTML 不改写，`<u>` 空横线由 CSS 撑开。
- **未做知识点筛选与错题本**：目前没有按知识点/章节筛题，也没有错题重练功能。
- **清单里的题量并不总是有值**：试卷列表接口不返回题量，`catalog.json` 只对已同步到本地的卷子填 `questionCount`，其余为 `null`；没有为了补题量去创建练习。
- **清单是生成时的快照**：练习 key、交卷状态会随账号使用变化，需要最新状态时重新运行 `npm run catalog`；批量下载是否跳过已同步会在运行时重新扫描 `data/`，不依赖清单里的旧标记。
- **全量清单请求量不小**：分类树有多少分支就要翻多少页，全量通常是百次级请求（默认每页 100 条、间隔 150ms）。只想看规模或避免频繁请求时，用 `--label` 限定子树，或用 `--max-pages` 限制每类页数。
- **不模拟 TLS 指纹**：请求头已对齐本机 Chrome（UA、Accept、Accept-Language、Referer、sec-ch-ua、sec-fetch-* 等），但 TLS 指纹、HTTP/2 头顺序、`accept-encoding` 由 Node 运行时（undici）决定，脚本层不做模拟。
- **快速练习会在账号里留下练习记录**：每次开始都新建一条；中途 Esc 不交卷，记录会保留。
- **离线模式依赖已同步数据**：`data/` 为空时只能使用快速练习，或先运行 `npm run sync`。

---

## 合规提醒

本项目使用的接口属于粉笔的非公开接口，仅供个人学习自用；公开发布或分发前请自行确认已获得相关授权。
