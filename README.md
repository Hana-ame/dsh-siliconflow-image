# dsh-siliconflow-image

让 DSH 支持 **SiliconFlow 生图模型** 的 Cordis 插件。三条使用路径共用同一份模型目录与同一个 API 客户端：

1. **作为可选模型（provider 路线）**：模型选择器里多出一个 `SiliconFlow 生图` 分组，选中 Kwai-Kolors / Qwen-Image / Z-Image / MOSS-Image 等模型后直接说“画一只猫”，生成的图片以 assistant 消息里的图片块显示在对话中。
2. **作为工具（任意模型可调用）**：注册 `generate_image` 工具，任何聊天模型都能调用；图片写入会话工作区（默认 `generated-images/`），并登记为交付物（文件卡片）。
3. **参数面板（对齐 playground）**：选中生图模型后，composer 上方出现「图像参数」条，可填 **图片尺寸 / 推理步数 / 随机种子 / 负面提示词** —— 与 [playground 图像生成页](https://cloud.siliconflow.cn/me/playground/image) 的四个字段一致。参数按会话持久化，adapter 与工具在下一次生成时生效。

参考文档：[SiliconFlow 图片生成](https://api-docs.siliconflow.cn/docs/userguide/capabilities/images) · [创建图片生成请求](https://api-docs.siliconflow.cn/docs/api/images-generations-post)

## 安装

源码：`/home/lumin/dsh-plugins/dsh-siliconflow-image`（零依赖、无构建步骤）。

```sh
dsh plugin --profile web add /home/lumin/dsh-plugins/dsh-siliconflow-image
dsh --profile web --dump-config | grep -A 3 siliconflow-image   # 应恰好一行 id: siliconflow-image
```

新 bundle 可由 profile 热重载激活；**模块代码**（本项目里的 `*.js`）改动只有新进程才会加载，改代码后需重启一次 DSH Web：

```sh
sudo -n systemctl restart dsh-web.service
# 从会话内部重启用 scripts/restart-verify.sh（systemd-run 平级瞬态单元，见文件头注释）
```

## 配置

`cordis.patch.yml` 的 `config`：

| 键 | 默认 | 说明 |
|---|---|---|
| `apiKeyRef` | `SILICONFLOW_API_KEY` | 经 `ctx.credentials` 解析的凭据引用；其次读同名环境变量；最后用 `apiKey` 字面值 |
| `baseURL` | `https://api.siliconflow.cn/v1` | OpenAI 兼容基址 |
| `defaultModel` | `OpenMOSS-Team/MOSS-Image` | `generate_image` 未指定模型时使用 |
| `outputDir` | `generated-images` | 工具落盘目录（相对会话工作区） |
| `watermark` | `false` | `false` 时发送 `X-Enable-Watermark: 0`（干净图）；`true` 保留“AI生成”可见水印 |
| `timeoutMs` | `600000` | 单次生成 + 下载预算。平台会排队，实测有 >165s 才返回的情况，所以故意放宽；真死掉的请求仍会在这里结束。**必须小于上游 `llm-pi-ai` 的 `streamIdleTimeoutMs`（本机配 900000）**，否则 harness 的看门狗先响，这个预算永远用不上 |
| `providerName` | `SiliconFlow 生图` | 模型选择器里的 provider 名 |
| `models` | 见下 | 覆盖/追加目录项：`[{id, name?, kind?('generate'\|'edit'), size?, sizes?, maxSteps?, defaultSteps?, description?, defaults?}]` |
| `parameterPanel` | `true` | 是否挂载 composer 图像参数面板（`false` 时连 `/api/siliconflow-image/params` 路由也不挂） |
| `paramsFile` | `.siliconflow-image-params.json` | 参数按会话持久化的 JSON 文件；相对路径按本包目录解析。删掉它就重置所有会话 |

凭据：`SILICONFLOW_API_KEY`（本机 `.credentials.yaml` 的 refs 里已有；也可在 设置 → 模型 里写入）。测试连通性：

```sh
curl -sS https://api.siliconflow.cn/v1/images/generations \
  -H "Authorization: Bearer $SILICONFLOW_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"Kwai-Kolors/Kolors","prompt":"a cat","image_size":"1024x1024","num_inference_steps":10}'
```

## 内置模型目录

快照来源：`GET /v1/models`（2026-11-12，97 个模型）中筛出的生图模型 + 官方文档的推荐尺寸。

| id | 类型 | 默认尺寸 | 尺寸集 | 步数上限 | 备注 |
|---|---|---|---|---|---|
| `Kwai-Kolors/Kolors` | 文生图 | 1024x1024 | 12 种（1:1/3:4/1:2/9:16/2:3/3:2/21:9…） | 50 | 中文提示词友好；`guidance_scale` 默认 7.5 |
| `Qwen/Qwen-Image` | 文生图 | 1328x1328 | 8 种（含 1664x928 / 928x1664） | 50 | 含文字排版最佳；官方配置 50 步、CFG 4.0 |
| `Tongyi-MAI/Z-Image` | 文生图 | 1024x1024 | 8 种比例 | 50 | |
| `Tongyi-MAI/Z-Image-Turbo` | 文生图 | 1024x1024 | 8 种比例 | **100** | 加速版；唯一放行 >50 步的模型 |
| `OpenMOSS-Team/MOSS-Image` | 文生图 | 1024x1024 | **仅 8 种比例** | 50 | playground 默认 40 步；**本插件默认模型** |
| `Qwen/Qwen-Image-Edit-2509` | 图生图/编辑 | 无 | 不支持该字段 | 50 | 1–3 张参考图；声明 `image` 输入，可在消息里附图 |
| `Qwen/Qwen-Image-Edit` | 图生图/编辑 | 无 | 不支持该字段 | 50 | 1 张参考图 |

**约束是实测的，不是抄文档的。** 2026-11-12 用真实 key 打这套模型时发现文档与实际有出入，插件按实测收紧闸门（非法请求在计费前就被拒，所以这些上界是从 provider 自己的校验错误里读出来的）：

- 文档写 `num_inference_steps` 上限 100，但除 `Z-Image-Turbo` 外**全部模型实际只到 50**（`51` 直接 400）。
- `MOSS-Image` 的 `image_size` **只接受那 8 个比例值**；传 `1328x1328`/`512x512`/`1664x928` 都 400，并回一行白名单。
- `Qwen-Image` 有像素预算：每边 >256 且 ≤2047，`宽×高 ≤ 2073600`；`2040x1024` 会 400。
- `guidance_scale` 与 `cfg` 只对各自模型有效；Edit 家族不接受 `image_size`。

闸门放在目录里（`sizes` / `maxSteps` / `defaultSteps`），面板与工具读同一份，所以表单永远开不出 provider 会拒的选项。

模型名支持别名：`Qwen-Image`、`kolors (快手)` 这类去掉厂商前缀/用显示名的写法会解析到目录项（避免 provider 返回 400 “model does not exist”）。

## 用法

**A. 选模型出图**：模型选择器 → `SiliconFlow 生图` → 选模型 → 直接描述画面（可在提示词里写 `1024x1024`/`928x1664` 覆盖尺寸）。回复里的图片块由 `conversation.message.images` 槽渲染，可点开看大图。

**A2. 参数面板（对齐 playground）**：选中任意 `SiliconFlow 生图` 模型后，composer 上方出现「图像参数」条，展开即有四个字段：

| 字段 | 形态 | 约束来源 |
|---|---|---|
| 图片尺寸 | 比例按钮（1:1 / 3:2 / 2:3 / 9:16 …），只列该模型接受的尺寸 | 目录 `sizes` |
| 推理步数 | 滑杆 + 数字框，上限随模型变（MOSS/Z-Image/Kolors 50、Z-Image-Turbo 100） | 目录 `maxSteps` |
| 随机种子 | 数字框 + 「随机」按钮；留空 = 随机 | `0 … 9999999999` |
| 负面提示词 | 多行文本 | 所有模型 |

比例标签用 **playground 的叫法**（`1216x832` → `3:2`），不是精确分数（精确算是 `19:13`，没人认得）。参数按 session 存进 `paramsFile`，刷新/重启都不丢；切到别的模型时，该模型不接受的值会被自动丢弃而不是让请求 400。

**B. 任意模型调用工具**：

```text
用 generate_image 工具画一张：赛博朋克重庆夜景，霓虹，雨后街道，1568x672
```

参数（取值与限制按 [创建图片生成请求](https://api-docs.siliconflow.cn/docs/api/images-generations-post) 对齐）：

| 参数 | 限制 |
|---|---|
| `prompt` | 必填，非空 |
| `model` | 目录 id，支持别名（`Qwen-Image` → `Qwen/Qwen-Image`） |
| `image_size` | 必须是该模型白名单里的值（见上表）；文生图必填（缺省用模型推荐值），编辑模型传了就报错 |
| `negative_prompt` | “不要出现的内容”；所有模型 |
| `seed` | 整数 `0 .. 9999999999` |
| `num_inference_steps` | 整数，上限按模型（多数 50、`Z-Image-Turbo` 100）；默认取目录值（MOSS 40 / Qwen-Image 50） |
| `guidance_scale` | 仅 `Kwai-Kolors/Kolors`，`0 .. 20`（默认 7.5） |
| `cfg` | 仅 `Qwen/Qwen-Image`，`0.1 .. 20`（官方配置 4.0） |
| `image` / `image2` / `image3` | 编辑模型参考图（URL 或 `data:image/...;base64`）；`Edit-2509` 最多 3 张、`Qwen-Image-Edit` 仅 1 张 |
| `output_path` | 工作区相对或绝对路径 |

越界/不适用参数在发请求前就报错（不静默忽略，也不烧钱）。工具返回绝对路径、尺寸、`seed`、`x-siliconcloud-trace-id`（`traceId`）与 `timings.inference`（秒），并在回复里提示用 `![描述](绝对路径)` 内联展示；文件同时登记为交付物。

**C. 同一会话里混用**：先用生图模型出图，再切回聊天模型继续对话是支持的（见下节）。旧的“生图模型出图 → 聊天模型”历史会被投影成文本占位符，不会把图片重新发给文本 provider。

## 设计要点（为什么不是“直接把图片塞进会话”这么简单）

- **assistant 消息里的图片块是前向兼容能力**：`dsh-llm` 的 `ImageBlock` 文档写明“valid in user or assistant content … 当前生产 adapter 声明 text-only 输出”。聊天 UI 的 `AssistantMarkdown` 已经能渲染 assistant 图片块，但 `pi-ai` / DeepSeek 适配器在**请求历史**里拒绝非 user/tool 角色的图片（`UNSUPPORTED_CONTENT`）。所以本插件：
  - 图片块带 `offloaded: true`（provider 请求里投影成占位文本；DeepSeek 适配器先投影后校验，单靠它即可）；
  - 另注册一个**持久化的消息投影事件** `siliconflow-image/assistant-image-project`：assistant 图片消息落盘后追加该事件，`pi-ai` 这类先校验后投影的 adapter 也能拿到干净历史。投影只改**模型可见历史**，durable log / UI / 附件库 / token meter 都不变，可回放。
- **辅助调用不烧钱**：`purpose: 'session-title'` / `'compaction'` 的调用只回短文本，不触发生图（否则自动会话标题也会生成一张图）。
- **只把最后一条人类消息当 prompt**：循环会注入 time-context / recall 等 plugin 来源的 user 角色消息；按 `source.kind === 'user'` 取最后一条人工消息。
- **结果即时落盘**：S3 签名 URL 只有 1 小时有效期，下载后写工作区并存入附件库。
- **请求可追踪**：每次请求带 `X-Trace-Id`（`dsh-<ts>-<rand>`）；平台在响应头 `x-siliconcloud-trace-id` 原样返回，错误消息里也带 `[trace …]`，排查时可直接给 SiliconFlow。
- **响应字段按文档解析**：`images[].url`、`timings.inference`（秒）、`seed`。
- **图片尺寸**：PNG/JPEG/WebP 头部解析宽高，用于回复与工具元数据。

## 测试

```sh
cd /home/lumin/dsh-plugins/dsh-siliconflow-image && node --test test/*.test.js
# 73 个用例：catalog / api / adapter 流式协议 / tool / 消息投影 /
#          参数模型与持久化（params）/ 面板路由（admin）/ 浏览器 bundle（client）
```

本机实测（2026-11-12）：

- 真实 API 冒烟：Kolors 1024x1024、10 步 → 200，3.3s，下载 1.15MB PNG，尺寸解析 1024x1024。
- 隔离实例（`DSH_HOME=/tmp/dsh-imgtest-home`，端口 3081，真实 key）：
  - 模型选择器出现 `SiliconFlow 生图`，7 个模型全部列出；选 Kolors → 发中文提示词 → 4 秒出图，聊天里显示 1024x1024 图片（DOM `<img>` 实测 1024x1024 blob）。
  - 生图模型出图后切到 `siliconflow/deepseek-ai/DeepSeek-V4.1-Flash` 继续对话：成功；投影事件 `siliconflow-image/assistant-image-project` 实测已落盘。
  - 聊天模型调用 `generate_image`：Qwen/Qwen-Image 出图，工作区落盘 `generated-images/iceland-black-sand-aurora-1024.png`（1024x1024 RGBA PNG，1.17MB），回复与交付物卡片出现。
- 参数面板实测（本机 3080，MOSS-Image）：选中模型后 dock 出现 `.sfi-wrap`；展开后四个字段齐全，尺寸按钮实测 8 个、步数滑杆 `max=50` 且显示 40、种子占位「随机」、负面词多行框；点 `832x1216` → `.sfi-sum` 变为 `832x1216` 且落盘文件出现该 session 的条目。
- 一次生成超时的复盘：`832x1216 / 6 步 / seed 424242 / 负面词` 同一请求先 164.7s 未返回（被判超时），10 分钟后原样重试 10.4s 通过 —— 平台排队偶发，不是参数问题；因此把预算从 180s 提到 300s，并让超时返回可路由的 `TIMEOUT`（带 `budget`/`trace`）而不是裸 abort。

## 注意

- **水印**：`watermark: false` 会传 `X-Enable-Watermark: 0`。官方文档的原话是“当且仅当需要对生成图片执行下游进一步处理时才应显式传入 0；此时开发者有法定义务自行对最终输出图片添加相关显式水印”。本插件默认关闭可见水印以便保存/二次处理，发布用途请自行补显式水印。
- **费用**：生成按张计费（SiliconFlow 定价随模型变化），`generate_image` 每次调用至少一张。`providerRetryPolicy` 只重试 429/5xx/超时，避免重复计费。
- **工具单次只出一张**：接口文档未列 OpenAI 的 `n` 语义，本插件不发送该字段。
- **编辑模型的工具路径**需要 `reference_images`（公网 URL 或 data URL）；模型路线的编辑模型声明了 `image` 输入，可直接在消息里附图。
- 生成文件不自动清理；交付物事件按会话记录，删除图片请手动删 `generated-images/`。
- **有 Client 半**（`client.js`，挂在 `conversation.input.dock`）：只画参数面板，图片渲染仍复用宿主 `dsh-client-ui-attachment` 的 `conversation.message.images` / `tool.call.images` 槽。面板只在 composer 选中的 provider 是 `siliconflow-image` 时渲染（聊天模型下不占位）。
- **面板的数据源是 Host 路由**，不是前端硬编码：`GET /api/siliconflow-image/params` 返回目录事实（每模型 `sizes`/`maxSteps`/`defaultSteps`）+ 该 session 已存参数；`POST` 校验后落盘。路由只允许 loopback 调用。
- 卸载：`dsh plugin --profile web remove dsh-siliconflow-image`（或从 `dsh.profile.bundles` 与 `dependencies` 撤下后重载），重启后生效。