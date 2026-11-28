# 本地图片文字识别

搜索按需使用 Tesseract.js 7.0.0、Tesseract.js-core 7.0.0 和 Tesseract 官方 `tessdata_fast` 的简体中文、繁体中文及英文模型。全部资源随项目分发，无需运行时 npm 依赖、系统 OCR 命令或外部 CDN。图片只在当前浏览器中处理，不会上传识别服务。

`tesseract.esm.min.js` 提供浏览器 API，`worker.min.js` 在独立 Worker 中执行识别。三个 `*-lstm.wasm.js` 文件分别提供普通、SIMD 和 relaxed SIMD 版本，内嵌 WASM；只使用 LSTM 模式，保留由上游自动选择的硬件回退。模型以 gzip 压缩，来源固定到 `tessdata_fast` 的提交 `87416418657359cb625c412a48b6e1d6d41c29bd`。

各文件的下载地址、包内路径及 SHA-256 保存在 `sources.json`；Tesseract.js、核心及模型采用 Apache-2.0，许可证与 Worker 的第三方声明一并保留。来源与 API 说明见 [Tesseract.js 本地部署](https://github.com/naptha/tesseract.js/blob/v7.0.0/docs/local-installation.md)、[Tesseract.js API](https://github.com/naptha/tesseract.js/blob/v7.0.0/docs/api.md) 和 [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast)。

更新时同时核对 API、Worker、核心版本及模型兼容性，更新来源与校验值，并在断开外网的浏览器中检查中文、英文和无文字图片。不要直接改写第三方生成文件。Node 服务只额外允许同源 Worker 和 WASM 编译，不开放 JavaScript `unsafe-eval`。识别结果按内容摘要缓存在浏览器 Cache Storage，存储受限或普通 HTTP 不具备摘要能力时回退到本次会话内存；更换模型或文字归一化方式时应更新 `js/image-text-search.js` 的缓存名称。
