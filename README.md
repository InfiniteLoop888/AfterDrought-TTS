# tts-afterdrought

酒馆扩展。抽出对白后，浏览器直接请求本机 TTS 服务并播放。角色参考音频、缓存和推理都在 TTS 服务里。

## TTS 服务接口

默认地址 `http://127.0.0.1:9881`，可在页面右下角 **TTS** 里改。

```http
POST /tts
Content-Type: application/json

{ "text": "别出声。", "speaker": "艾莉丝", "emotion": "default" }
```

`emotion` 可以忽略。服务自己用 `speaker` 找参考音频。

成功时返回 `audio/wav`。也可以返回 `{"audio_base64": "..."}`。  
另外提供 `GET /health`，页面用它显示服务是否在线。响应要允许酒馆页面跨域。

## 接到酒馆

```bash
ln -s /home/lenovo/zzzbzhang/github/tts-afterdrought \
  /你的/SillyTavern/data/default-user/extensions/tts-afterdrought
```

刷新酒馆。默认不自动读，点消息下的「朗读」或某一句。

正文里有 `[角色, 情绪] 对白` 或 `【角色, 情绪】对白` 时按角色拆开。没有这种标签时，整段消息的 `speaker` 是 `default`。
