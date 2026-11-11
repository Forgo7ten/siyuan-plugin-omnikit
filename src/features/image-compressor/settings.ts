/** Feature-local settings only; it does not own the feature enable preference. */
export const IMAGE_FEATURE_ID = "imageCompressor";

export interface CompressionSettings {
  quality: number;
  maxDimension: number;
  minSizeBytes: number;
  minSavingRatio: number;
  skipWebP: boolean;
  skipGIF: boolean;
  skipSVG: boolean;
  skipExcalidraw: boolean;
  concurrencyDesktop: number;
  concurrencyMobile: number;
}

export const compressionDefaults: CompressionSettings = {
  quality: 0.8,
  maxDimension: 4096,
  minSizeBytes: 100 * 1024,
  minSavingRatio: 0.05,
  skipWebP: true,
  skipGIF: true,
  skipSVG: true,
  skipExcalidraw: true,
  concurrencyDesktop: 2,
  concurrencyMobile: 1,
};

export type ImageSettings = CompressionSettings;
export const imageDefaults: ImageSettings = { ...compressionDefaults };
