# tts-afterdrought

酒馆扩展。从回复里抽出对白，交给本机语音网关，再播放返回的 WAV。

默认地址 `http://127.0.0.1:9881`，也就是 `AfterDrought/tts-api`。页面上的 **TTS** 按钮可以拖动，点开就是设置。以前如果地址还留着 `7860`，加载时会改到这个网关。

扩展只发送角色和对白，不上传参考音频，也不带 IndexTTS 的原始参数：

```json
{
  "character_id": "甘雨",
  "text": "你、你怎么突然说这种话……",
  "emotion": { "type": "vector", "preset": "害羞", "vector": null, "weight": null }
}
```

角色名对上网关配置里的 id、显示名或别名。音色、默认情绪和说话习惯都在网关的 `characters/` 里。

正文里的 `[角色, 情绪]`、`【角色, 情绪】` 会就地换成语音条。同一行末尾可以加导演指令，它不会被读出来：

```text
[甘雨, 害羞] 你、你怎么突然说这种话……〖vd:{"delivery":{"intensity":"soft","pace":"gentle"}}〗
```

指令不是合法 JSON，或情绪名不在允许范围内时，这句仍然按角色默认来合成。

勾上「注入对白格式」后，扩展用 `setExtensionPrompt` 把格式要求放进聊天上下文。取消勾选后，下一次生成不再带这段提示。
