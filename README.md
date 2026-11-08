# 同行 · walkbuddy

手机打开网页 → 后置摄像头一直开着 → 你说话或打字，屏幕里的「她」看着你眼前的东西跟你聊。纯静态，没有服务器，电脑不用开。

在线地址：https://l-ui45.github.io/walkbuddy/

## 用法

1. 手机浏览器打开上面的地址（必须是 https，否则拿不到摄像头）。
2. 点「开始」，允许摄像头。
3. 点设置，选模型来源，填自己的 API Key，保存。
4. 按住话筒说话，松开就发出去；也可以直接打字。

建议把页面「添加到主屏幕」，全屏用起来像个小 App。

## 模型来源

| 来源 | 默认模型 | 说明 |
| --- | --- | --- |
| DeepSeek | `deepseek-flash` | 便宜，能看图，够用 |
| 硅基流动 | `Qwen/Qwen2.5-VL-7B-Instruct` | 有免费视觉模型，按控制台给的模型名填 |
| 本机 Ollama | `qwen3-vl:2b` | 零成本，但要电脑一直开着，且要设 `OLLAMA_ORIGINS=*` |

Key 存在手机浏览器的 localStorage 里，不上传任何地方。但这个页面是公开的，别在里面写别人的 key。

## 省钱

默认每句话都截一张 512px 的图发过去。设置里打开「省钱模式」后，只有话里提到「看/这个/那边/什么」这类词才截图。一轮对话大约两分钱，一天聊两百句也就几毛。

## 已知限制

- 语音识别用的是浏览器自带的（Chrome/Edge 有，Safari 17 以后部分有），没有的话只能打字。
- 朗读用系统 TTS，中文音色取决于手机装了什么。
- 摄像头切后台会被系统掐断，回到页面会自动重连。

## 文件

```
index.html            页面骨架
style.css             样式
app.js                主逻辑：相机、对话、朗读、设置
lib/providers.js      三家模型的请求与流式解析
lib/vision.js         截帧、开关摄像头
lib/prompt.js         人设与提示词
lib/speech.js         语音识别与朗读
tools/serve.mjs       本地静态服务器（默认 5199）
tools/api-check.mjs   只用 Node 打 API，测人设与延迟
tools/smoke.mjs       真 Chrome + 假摄像头跑一遍完整流程
```

## 自己跑一遍

```bash
node tools/serve.mjs                    # 电脑上看：http://127.0.0.1:5199
node tools/api-check.mjs                # 只测模型
node tools/smoke.mjs                    # 端到端（会用你的 key 真发两条）
APP_URL=https://l-ui45.github.io/walkbuddy/ node tools/smoke.mjs   # 测线上
```

`tools/` 里的脚本会读 `~/.dsh/.credentials.yaml` 里的 `DEEPSEEK_API_KEY`，不用自己填。
