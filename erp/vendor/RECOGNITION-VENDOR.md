# 本機辨識用的第三方程式（離線、不連外部服務）

| 路徑 | 來源 | 版本 | 授權 |
| --- | --- | --- | --- |
| zxing/reader.js, zxing/share.js, zxing/zxing_reader.wasm | npm `zxing-wasm`（dist/es/reader、dist/reader） | 3.1.4 | MIT（zxing/LICENSE） |
| tesseract/tesseract.esm.min.js, tesseract/worker.min.js | npm `tesseract.js`（dist） | 7.0.0 | Apache-2.0（tesseract/LICENSE.md） |
| tesseract/tesseract-core-*-lstm.wasm.js | npm `tesseract.js-core` | 7.0.0 | Apache-2.0（tesseract/core-LICENSE） |
| tessdata/chi_tra.traineddata.gz, tessdata/eng.traineddata.gz | npm `@tesseract.js-data/chi_tra`、`@tesseract.js-data/eng`（4.0.0_best_int） | 1.0.0 | Apache-2.0（tesseract-ocr/tessdata） |

zxing/reader.js 只把 `../share.js` 改成 `./share.js`；tesseract 兩個檔案移除了 sourceMappingURL 註解。其餘未修改。
