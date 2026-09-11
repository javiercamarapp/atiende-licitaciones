export type {
  LiveVerification,
  OcrBoundingBox,
  OcrInput,
  OcrLine,
  OcrPageResult,
  OcrPort,
  OcrResult,
  OcrWord,
} from "./types.js";
export { OcrNotConfiguredError } from "./types.js";
export { TesseractOcrAdapter, createTesseractOcrAdapter, type TesseractOcrAdapterOptions } from "./tesseract-adapter.js";
export { FakeOcrAdapter, type FakeOcrAdapterOptions, type FakeOcrResponder } from "./fake-adapter.js";
export { createOcrPortFromEnv, type OcrEngineKind, type OcrEnv } from "./factory.js";
