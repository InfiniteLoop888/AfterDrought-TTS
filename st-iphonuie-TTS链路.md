# ST-iPhonie TTS 链路说明

> 范围：正文语音（`<tts>角色|情绪|文本</tts>`）从「模型输出」到「扬声器出声」。
> 每节标注 **文件 → 符号（行号）**。行号以当前版本为准（`RUNTIME_VERSION` 见 `index.js:47`），改动后请按符号名检索。

## 0. 总览

```
提示词注入(台词格式) → 模型回复原文 → parseDialogue 得到 lines[]
                                        │
        ┌───────────────────────────────┴────────────────┐
        ▼                                                ▼
  renderDialogue / waveMarks 渲染声波            dialogueProblems 格式诊断
        │                                                │
        ▼                                                ▼
  点击 → playMessage → DialoguePlayer.start        decorate() 回写按钮状态
        │
        ▼
  make() → requestOf() → buildRequest()（各引擎 payload）
        │                        │
        │                        ▼
        │              TTSBackend.synthesize() → post()/viaTavern()/fetch
        │                        ▼
        │              decode* / audioBlob() → Blob → AudioCache
        ▼
  BrowserAudio.play()（effectChain 音效）→ 出声
```

装配点：`index.js:652`（`backend = new TTSBackend(...)`，`player = backend.player`）；播放器实例在 `core/backend.js:232` 创建。

---

## 1. 阶段 0：台词来源（提示词侧）

| 环节 | 位置 |
| --- | --- |
| 默认格式 `` “{译文}”<tts>{角色}|{情绪}|{文本}</tts> `` | `core/protocol.js` → `DEFAULT_FORMAT`(L4) |
| 自由正文格式 | `core/protocol.js` → `FREE_FORMAT`(L6) |
| `<i-tts>` 短标签兼容 | `core/protocol.js` → `shortVoiceFormat`(L8)、`builtinVoiceFormat`(L9) |
| 格式编译（字面量 + 字段名） | `core/protocol.js` → `compileFormat`(L22) |
| 可尝试格式列表 | `core/protocol.js` → `knownFormats`(L18) |
| 对白规则文案 | `core/protocol.js` → `CONTRACT_PROMPT`(L117)、`dialogueContract`(L139) |
| 生成提示词条目 | `core/protocol.js` → `promptPlan`(L141) |
| 本轮允许发言的角色 | `index.js` → `speakers()`(L151) |
| 写入酒馆上下文 | `index.js` → `inject()`(L155) |
| 生成拦截器（历史中剔除图/语音标签，最新一条留作示例） | `index.js` → `globalThis.stIphonieInterceptor`(L65) |
| 「回复后单独配音」规则 | `index.js` → `voicePlan`(L130)、`storyFormat`(L129) |

`inject()` 仅在 `voiceOn()` 且 `voiceMode==='inline'` 时注入；`speakers()` 限定规则覆盖范围，避免整卡角色都写一遍。

## 2. 阶段 1：拿到回复原文

| 环节 | 位置 |
| --- | --- |
| 新回复事件 | `index.js` L664（`MESSAGE_RECEIVED` 订阅） |
| 进入接收流程 | `index.js` → `receiveStoryReply(id)`(L211) |
| 记录快照（消息/聊天/swipe/时间/名字） | `index.js` → `markStoryReply(id)`(L196) |
| 校验并处理 | `index.js` → `processReceivedStoryReply(id)`(L206) |
| 定稿后续（配音计划/挑音色/提前生成） | `index.js` → `afterStoryReply(id)`(L216) |
| 读取消息（含隐藏楼层） | `index.js` → `currentMessage(id)`(L164) |
| 防编辑/滑动播错 | `index.js` → `unchanged(snap)`(L170)、`sameLines`(L167) |

原文即 `ctx.chat[id].mes`，是全链路唯一输入。

## 3. 阶段 2：解析成「台词行」信息结构

### 3.1 主入口 `parseDialogue`

| 环节 | 位置 |
| --- | --- |
| 入口 `parseDialogue(message, format)` | `core/protocol.js` L79 |
| `<i-tts>` 归一化 + 偏移还原 | L82–L95 |
| 格式编译、自由格式分支 | L97 |
| 主流程（修复 → 排除代码 → 精确 → 宽松 → `mendLine`） | L100–L102 |

### 3.2 扫描器（宽松度递增）

| 符号 | 位置 | 负责情况 |
| --- | --- | --- |
| `repaired` | `core/protocol.js` L34 | 大写 `<TTS>`、全角 `｜`、斜体/括号心声、引号变体 |
| `codeSpans` | L24 | 排除代码块/行内代码 |
| `exactLines` | L35 | 严格按格式（含译文），`start/end` 精确 |
| `looseLines` | L46 | 两字段 `角色|文本`、无引号译文 |
| `freeLines` | L63 | `FREE_FORMAT`：正文原样，标签只换控件 |
| `mendLine` | L55 | 中文被拆成「译文 + 标签」时补全 |

### 3.3 行结构（下游契约）

由 `exactLines`(L41)、`looseLines`(L48)、`freeLines`(L75) 产出：

| 字段 | 含义 |
| --- | --- |
| `start`/`end` | 原文区间（渲染替换用） |
| `translation` | 显示译文 |
| `role` | 说话角色（原文写法） |
| `emotion` | 情绪（可带 `心声·`/`电话·` 前缀） |
| `text` | 实际朗读文本 |
| `tagOnly` | 标签前无可见译文（自由格式） |
| `displayStart` | 自由格式可见引语起点 |
| `said` | 归并前原名（`withRoles` 添加） |
| `effect` | `phone`/`inner`（`withMarks` 或预设标记添加） |
| `narration`/`uiIndex` | 旁白段标记 / 界面第几个声波（`index.js:257` 补） |

### 3.4 缓存与角色归并

| 环节 | 位置 |
| --- | --- |
| 解析缓存（key = 原文 + 别名表） | `index.js` → `parsed(message)`(L147) |
| LRU 容器（60 条） | `index.js` → `remembered`(L144) |
| 别名 → 统一角色名 | `core/routes.js` → `withRoles`(L44)；别名键 `index.js:146` `roleKey()` |
| 播放用行（叠加音效标记） | `index.js` → `messageLines(snap)`(L176)；`core/voice-fx.js` → `withMarks`(L85) |

### 3.5 格式诊断（不阻断，只提示）

| 环节 | 位置 |
| --- | --- |
| 列出「有标签但未识别」及原因 | `core/protocol.js` → `dialogueProblems`(L105) |
| 消息下方提示条 | `index.js` → `lint(element, raw, lines)`(L319) |

## 4. 阶段 3：渲染声波按钮

### 4.1 直接渲染（普通聊天）

`core/protocol.js` → `renderDialogue(message, format, marker, inner)`(L111)，产出：

```html
<span class="sttts-utterance" data-sttts-line="索引" data-sttts-token="本次页面标记">
  <span data-sttts-translation>“译文”</span>
  <button class="sttts-play" data-sttts-action="line" data-sttts-state="ungenerated">
    <span data-sttts-wave><i data-sttts-bar></i>×5</span>
  </button>
</span>
```

- `data-sttts-line` 是**解析数组下标**，点击时回查 `lines[index]`（`index.js:644`）。
- `data-sttts-token` 为本次加载的随机 marker（`index.js:48`），用于识别旧声波。
- 按钮模板常量：`waveButton`(`core/protocol.js:157`)。

### 4.2 先标记后渲染（前端美化卡）

卡片 regex 插入 `<button>` 会切碎卡片，故两步走：

| 步骤 | 位置 |
| --- | --- |
| 1. 译文包进私用区标记 `MARK_OPEN/MID/CLOSE` | `core/protocol.js` → `markDialogue`(L160)；常量 L155 |
| 2. regex/Markdown 跑完后把标记换成按钮 | `core/protocol.js` → `waveMarks`(L173) |
| 被 regex 拆坏的标记只删不留 | `waveMarks` 内 `cutInto`(L166、L177) |
| 卡内代码/整页 HTML 撤回纯译文 | `core/protocol.js` → `unwaveFramed`(L150) |

### 4.3 钩子注册（谁调用渲染）

| 钩子 | 位置 | 作用 |
| --- | --- | --- |
| 总装配 `transform(text, marks, id)` | `index.js`(L139) | 手机标签 → 立绘 → 音效 → BGM，再解析渲染语音 |
| BEFORE_REGEX | `index.js` L656 | `transform(text, late, id)`，`late` 表示需两段式 |
| AFTER_MARKDOWN | `index.js` L658 | `waveMarks(...)` 标记变按钮 |
| AFTER_REGEX | `index.js` L660 | `unwaveFramed(...)` 清卡内声波 |
| 老版本酒馆补画 | `index.js` → `legacyFormat()`(L305) | `transform` + `messageFormatting` 重画 |
| 关闭正文语音 | `core/protocol.js` → `plainDialogue`(L113) | 只留译文 |

### 4.4 画完后补状态

| 环节 | 位置 |
| --- | --- |
| 扫描消息，写 `data-sttts-state`/`title`/`aria-*` | `index.js` → `decorate(only)`(L315) |
| 状态：`ungenerated/unbound/ready/played/generating/playing/paused/waiting` | `core/player.js` → `lineState(line)`(L270)；中文标签在 `index.js:315` |
| 帧节流（40ms） | `index.js` → `queueRender`(L285) |
| 播放中柱高 | `index.js` → `animateLines()`(L306) + `core/player.js` → `levels()`(L185) |

## 5. 阶段 4：点击 → 播放队列

| 环节 | 位置 |
| --- | --- |
| 全局捕获点击 | `index.js` → `click(event)`(L637)，注册 L678 |
| 动作分发 `all/line/sound/bgm` | `index.js` L644 |
| 单行 / 整条播放 | `index.js` → `playMessage(id, index)`(L257)；整条时 `index` 为空 |
| 整篇朗读（旁白） | `index.js` L259（`readingPlan` + `NARRATOR`） |
| 逐句播放 | `index.js` → `playStepMessage(id)`(L261) |
| 舞台单句 | `index.js` → `playLine(id, index)`(L265) |
| 旁白单句 | `index.js` → `narrateLine(text)`(L267) |
| 交给播放器 | `core/player.js` → `start(lines, valid, settings, {ahead, stepwise, onStart})`(L303) |

`playMessage` 先确认消息未变、必要时补配「回复后单独配音」、给 `lines` 补 `uiIndex`(L257)，再 `player.start`(L260)。

---

## 6. 阶段 5：请求构建（信息结构 → HTTP）

四层：**行 → request → 引擎差异 → 发送**。

### 6.1 行 → request

| 环节 | 位置 |
| --- | --- |
| 组装语音请求（供 `make`/`retake`） | `core/player.js` → `buildVoiceRequest`(L344) |
| 取生效路由 + 算缓存键 | `core/player.js` → `requestOf(line, route, s)`(L349) |
| 真正构建 | `core/providers.js` → `buildRequest(engine, connection, route, line, references, options)`(L44) |
| 情绪前缀先摘下（`心声·/电话·` 不进引擎） | `core/providers.js` L44 首行调用 `speakable`(`core/voice-fx.js:24`) |
| 连接参数校验/克隆/默认值 | `core/providers.js` → `checkedConnection`(L14) |
| 基础 body/query 按参数目录生成 | `core/parameters.js` → `requestPreview`(L157) |
| 情绪 → 引擎句首标签 | `core/parameters.js` → `emotionTag`(L220) |
| MiniMax 固定情绪词映射 | `core/parameters.js` → `miniEmotion`(L217) |

### 6.2 各引擎分支（payload 差异）

统一分支在 `core/providers.js` L48–L76：

| 引擎 | 位置 | 关键 payload / 处理 |
| --- | --- | --- |
| `custom` | `providers.js:48` → `core/custom-voice.js` → `buildCustomRequest`(L143) | 用户模板 URL/method/headers/body；多参数集用 `config` 区分 |
| `doubao` | `providers.js:50` → `core/doubao.js` → `buildDoubaoRequest`(L14) | 资源 ID/音色/编码在 `doubao.js` 组装 |
| `fish` | `providers.js:58–60`、L69–L76；`parameters.js:161` | 原生 `{base}/v1/tts`：headers `{model}`，body `{text, reference_id, format}`，参考音频写 `provider.options['fish-audio'].references`(L60)；OpenAI 中转改 `/v1/audio/speech`(L74–L75)，原请求留 `official` 供缓存键复用 |
| `mini` | `providers.js:62`；`parameters.js:12` | `voice_setting.emotion` 仅命中固定词才写；`audio_setting.format/sample_rate/channel` 决定返回编码 |
| `eleven` | `providers.js:65`；`parameters.js:157` | `language_code` 按角色语言补；部分参数走 query；`transport==='eleven-dialogue-ws'` 改走 `elevenTurboSpeech`(L192) |
| `mimo` | `providers.js:53–55`、L64 | 预置音色白名单校验；克隆把样本转 `data:audio/*;base64` 写入 `body.audio.voice`；输出固定 `wav` |
| 旁白/系统朗读 | `core/player.js:463` | 不走 HTTP，直接用浏览器 `speechSynthesis` |

### 6.3 统一 request 结构

`core/providers.js` L77–L79 返回：

```js
{ engine, transport, url, body, voice, official?, headers?, viaTavern?,
  format, sampleRate, channels }
```

`format/sampleRate/channels` 规则也在 L79：mimo→wav/24000；fish→连接参数；mini→`audio_setting.*`；其它由 `output_format` 解析。URL 与 query 拼接在 L78。

### 6.4 URL / 鉴权 / 发送

| 环节 | 位置 |
| --- | --- |
| Fish 基址 | `core/parameters.js` → `fishBase`(L146) |
| OpenAI 兼容路径 | `core/parameters.js` → `openaiSpeech`(L150) |
| 鉴权头（Bearer / `xi-api-key` / `X-Api-Key`） | `core/providers.js` → `headers(engine)`(L183) |
| 单次合成总入口（MCP/custom/ws/HTTP） | `core/providers.js` → `synthesize(request, signal)`(L189) |
| 普通 POST（豆包另加 `X-Api-Resource-Id`） | `core/providers.js` → `post`(L352–L353) |
| 酒馆 `/proxy/` 转发 | `core/providers.js` → `viaTavern`(L355)；代理函数由 `core/backend.js:162` 注入 |
| 真实 fetch（超时、`credentials:'omit'`、`redirect:'error'`） | `core/providers.js` → `fetchWithPolicy`(L87) → `fetch`(L184) |
| 多密钥轮换（401/402/403/429） | `core/providers.js` L200–L204；`nextKey`(L180)、`useKey`(L182) |
| 错误文案 | `core/providers.js` → `httpError`(L134)、`REASONS`(L101) |
| 错误信息密钥脱敏 | `core/providers.js` L204/L206 |

### 6.5 `custom` 额外步骤

| 步骤 | 位置 |
| --- | --- |
| 串行化（同一时刻只换一次模型） | `core/providers.js` → `speakCustom`(L227) |
| 实际执行（密钥/参考音频/幂等 ID/`before` 步骤） | `core/providers.js` → `speakCustomNow`(L232) |
| 生成 `{url, init}`（模板变量替换） | `core/custom-voice.js` → `customInit`(L189) |
| Gradio 参考音频上传 | `core/providers.js` → `gradioUpload`(L286) |
| 直连失败 → 酒馆代理（记住 origin） | `speakCustomNow` 内 `send`(L250–L252) |
| 504 排队重试（带幂等 ID） | `speakCustomNow` L262–L263 |
| 解析响应 | `core/custom-voice.js` → `readCustomAnswer`(L355) |

## 7. 阶段 6：响应 → 音频 Blob

| 引擎 | 位置 | 解析 |
| --- | --- | --- |
| 统一分发 | `core/providers.js` L219–L221 | 按 engine 选解码器 |
| 豆包 | `providers.js:219` → `core/doubao.js` → `doubaoAudio`(L32) | 取字节后按返回结构取音频 |
| MiMo | `providers.js:220` → `decodeMimo`(L96) | OpenAI chat 形状，base64 在 `choices[0].message.audio.data` |
| MiniMax | `providers.js:221` → `decodeMini`(L89) | 非流式：hex 或 `output_format==='url'` 再下载；流式：SSE 分片，`status===2` 收尾 |
| ElevenLabs ws | `providers.js:192` → `core/eleven-dialogue.js` → `elevenTurboSpeech` | 二进制帧 |
| 其它 | `providers.js:221` 后半 | `limitedBytes` → `unpacked` → `audioBlob` |

工具：

| 函数 | 位置 | 作用 |
| --- | --- | --- |
| `limitedBytes` | `core/providers.js:86` | 流式读取，限 64MB |
| `hexBytes` | `core/providers.js:81` | hex → `Uint8Array` |
| `wavePCM` | `core/providers.js:82` | 裸 PCM 套 WAV 头 |
| `g711` | `core/providers.js:83` | u-law/a-law → PCM |
| `audioBlob` | `core/providers.js:84` | 统一 Blob，mime 按 `format` |
| `unpacked` | `core/audio-bytes.js:24` | 识别/解压容器 |
| `audioKind` | `core/audio-bytes.js:4` | 探测真实类型 |

单行过长被拒的兜底：`core/player.js` → `say()`(L334) 捕获 `tooLong`，由 `halves()`(L16) 在句末/逗号/空格切两半，分别合成后 `joinAudio()`(`core/audio-join.js:57`) 拼接，最多递归 4 层。

## 8. 阶段 7：缓存 / 提前生成 / 复用

| 环节 | 位置 |
| --- | --- |
| 缓存键（请求哈希，抹平 Fish 中转/直连差异） | `core/cache.js` → `requestHash`(L6) |
| 缓存实现（IndexedDB） | `core/cache.js` → `AudioCache`(L25)；`get`(L82)、`has`(L83)、`put`(L84)、`remove`(L120) |
| 取音频：内存 → IDB → 合成 → 回写 | `core/player.js` → `make(line, route, s, signal, found, still)`(L368) |
| 同键并发去重 | `make` 内 `this.making`(L381–L401) |
| 生成后写缓存/热区 | `make` L404–L411 |
| 提前生成（不播放） | `core/player.js` → `prepare(lines, {valid, signal, each})`(L419)；调用 `index.js:83` `prepareReply` |
| 预取下一句 | `core/player.js` → `makeAhead(index, signal)`(L436)，`run` 内 L513 触发 |
| 重新配音 | `core/player.js` → `retake(line)`(L358) |
| 已播标记 | `core/player.js` → `this.played`(L518 写入)，`lineState`(L270) 读取 |

## 9. 阶段 8：播放与音效

| 环节 | 位置 |
| --- | --- |
| 播放主循环（旁白/找路由/取音频/播放/下一句） | `core/player.js` → `run(epoch)`(L456) |
| 找角色路由（引擎/音色） | `run` L481（`findRoute`，`core/routes.js`） |
| 无音色：跳过或停下等人选 | `run` L486–L498；回调 `unknown` 至 `index.js:347` |
| 相位：`generating/playing/paused/waiting/error/idle` | `emit` 于 L495/L507/L515 等 |
| WebAudio 播放（解码 + 分析器） | `core/player.js` → `BrowserAudio.play(blob, signal, {effect, onStart})`(L111) |
| 音效插入点 | `play` L131 → `core/voice-fx.js` → `effectChain(ctx, effect, out)`(L117) |
| 音效判定（`心声`/`电话`/预设标记） | `core/voice-fx.js` → `voiceEffect`(L15)、`lineEffect`(L30)、`VOICE_EFFECTS`(L12)、`withMarks`(L85) |
| 暂停/继续 | `core/player.js` → `toggle()`(L563) |
| 停止（中止请求、清队列） | `core/player.js` → `stop(message)`(L283) |
| 挑完音色后继续 | `core/player.js` → `continuePending()`(L596)；调用 `index.js:349` |
| 解锁音频设备并启动 | `core/player.js` → `unlockAndRun()`(L589) |
| 状态上抛 | `core/backend.js:234` `change(state)` → `index.js:269` `status(value)` |

`status()` 负责把状态同步到浮动球、面板、`#sttts-toggle`/`#sttts-stop` 与声波动画。

## 10. 文件职责速查

| 文件 | 职责 | 关键符号 |
| --- | --- | --- |
| `index.js` | 宿主装配、DOM 钩子、点击入口、状态回写 | `transform`(139)、`parsed`(147)、`messageLines`(176)、`playMessage`(257)、`decorate`(315)、`click`(637)、钩子(656–660) |
| `core/protocol.js` | 格式、解析、渲染、提示词 | `parseDialogue`(79)、`renderDialogue`(111)、`markDialogue`(160)、`waveMarks`(173)、`promptPlan`(141) |
| `core/voice-fx.js` | 音效判定与 WebAudio 节点链 | `voiceEffect`(15)、`lineEffect`(30)、`withMarks`(85)、`effectChain`(117) |
| `core/player.js` | 播放队列、请求组装、缓存调度 | `buildVoiceRequest`(344)、`requestOf`(349)、`make`(368)、`prepare`(419)、`run`(456) |
| `core/providers.js` | 各引擎 payload / 发送 / 解码 | `buildRequest`(44)、`synthesize`(189)、`post`(352)、`decodeMini`(89) |
| `core/parameters.js` | 端点、参数目录、情绪词表 | `requestPreview`(157)、`emotionTag`(220)、`fishBase`(146) |
| `core/backend.js` | 设置/缓存/播放器/密钥的外观层 | 构造(152)、`player`(232)、`voiceBalance`(909)、`keyStatus`(924)、`voiceFormat`(1865) |
| `core/cache.js` | 音频缓存 | `requestHash`(6)、`AudioCache`(25)、`get`(82)、`put`(84) |
| `core/routes.js` | 角色→路由、别名归并 | `withRoles`(44) |
| `core/doubao.js` | 豆包请求/响应 | `buildDoubaoRequest`(14)、`doubaoAudio`(32) |
| `core/custom-voice.js` | 自定义接口 | `buildCustomRequest`(143)、`customInit`(189)、`readCustomAnswer`(355) |

## 11. 排查建议（按症状定位）

| 症状 | 先看 |
| --- | --- |
| 回复里没有声波按钮 | `parseDialogue`(protocol:79) 是否返回 lines → `transform`(index:139) 是否被调用 → `lint`(index:319) 提示 |
| 有声波但点不动 | `click`(index:637) 的 `data-sttts-line` 是否对得上 → `parsed` 缓存是否失效 |
| 点了没声音 | `make`(player:368) → 是否走缓存 → `run`(player:456) 的相位 → `BrowserAudio.play`(player:111) |
| 报鉴权/余额 | `keyStatus`(backend:924)、`headers`(providers:183)、`httpError`(providers:134) |
| 报格式不支持 | `buildRequest`(providers:44) 的 `format` 与 `audioBlob`(providers:84) 的 mime 映射 |
| 音色不对/不播 | `findRoute`(player:481)、`unknown` 回调(index:347) |
| 心声/电话没效果 | `voiceEffect`(voice-fx:15)、`withMarks`(voice-fx:85)、`effectChain`(voice-fx:117) |
