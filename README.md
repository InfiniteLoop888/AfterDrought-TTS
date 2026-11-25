# tts-afterdrought

酒馆扩展。抽出对白后，浏览器直接请求本机 IndexTTS2 Studio 并播放。

默认地址 `http://127.0.0.1:7860`，可在页面右下角 **TTS** 里改。

```http
POST /api/v1/tts
Content-Type: multipart/form-data

text=别出声。
spk_audio=<参考音频文件>
emo_mode=0
```

情绪名在扩展里换成 IndexTTS 的参数：

| 对白里的情绪 | 请求 |
| --- | --- |
| 不写、`default`、日常、温柔 | `emo_mode=0`，沿用参考音频 |
| 开心、生气、悲伤、害怕、厌恶、低落、惊讶、平静 | `emo_mode=2`，8 维向量 |
| 害羞、委屈、耳语 | `emo_mode=3`，情绪描述文本 |

没选音色文件时，用服务自带的 `voice_03.wav`。选过的文件存在浏览器里，所有角色共用这一条参考音频。

成功时服务先推 SSE，`done.wav` 指向生成的 WAV，扩展再把这段音频播出来。`GET /api/v1/health` 用来显示服务是否在线。

酒馆页面和 7860 不同源。重启后的 IndexTTS 对预检和健康检查都返回 `Access-Control-Allow-Origin: *`，浏览器可以直接读响应。

## 接到酒馆

把本目录链到酒馆扩展目录后刷新：

```text
SillyTavern/data/default-user/extensions/tts-afterdrought
```

默认不自动读，点消息下的「朗读」或某一句。

正文里有 `[角色, 情绪] 对白` 或 `【角色, 情绪】对白` 时按句拆开。标记同一行里的引号对白或这一行剩下的文字会被朗读，后面另起一行的旁白不会读进去。没有这种标签时，整段消息的情绪按参考音频原样读。

右下角默认勾着「注入对白格式」。扩展用酒馆的 `setExtensionPrompt` 把格式要求放进聊天上下文、深度 1、系统角色，不改世界书。情绪只允许 `default、开心、生气、悲伤、害怕、厌恶、低落、惊讶、平静、害羞、委屈、耳语`。取消勾选后，下一次生成不再带这段提示。
