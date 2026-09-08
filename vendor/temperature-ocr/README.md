# Local vehicle-number OCR dependencies

Loaded lazily by `driver-temperature-ocr.js`. The worker, WebAssembly and language
models are served from this ERP's own origin. Photographs are never submitted to
an OCR service. Only metadata is recognized; the printable image is unchanged.

- [Tesseract.js 6.0.1](https://github.com/naptha/tesseract.js/tree/v6.0.1):
  `tesseract.min.js`, `worker.min.js`, bundled license notices from the npm package.
- [Tesseract.js-core 6.0.0](https://github.com/naptha/tesseract.js-core/tree/v6.0.0):
  four unmodified `.wasm.js` builds, including SIMD/non-SIMD alternatives.
- [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast/tree/87416418657359cb625c412a48b6e1d6d41c29bd):
  `eng.traineddata` and `kor.traineddata`, gzip-compressed at level 9.

Apache-2.0 licenses are included alongside these files. Do not edit generated
vendor code. Source maps are omitted; the distributed JavaScript is unmodified.
See the [upstream local-installation documentation](https://github.com/naptha/tesseract.js/blob/v6.0.1/docs/local-installation.md)
for worker/core/language path configuration.
