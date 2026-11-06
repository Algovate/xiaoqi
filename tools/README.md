# tools

## OCR

`ocr.swift` 使用 macOS Apple Vision 做本地 OCR，支持图片和 PDF。

```bash
pnpm ocr:build
```

产物是 `tools/ocr-bin`（已 gitignore，需本机编译）。Linux 上不可用；用 `OCR_ENABLED=false` 或换 tesseract/云 OCR。

环境变量：

```dotenv
OCR_ENABLED=auto
OCR_BIN=
```
