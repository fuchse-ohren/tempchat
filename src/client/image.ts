/** 画像の縮小・WebP圧縮パイプライン（FR-7.4/7.5 / 設計 §7.3） */

import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_EDGE,
  IMAGE_MIME,
  IMAGE_QUALITY_START,
  IMAGE_QUALITY_STEPS,
} from "../shared/constants.ts";

export interface CompressedImage {
  bytes: ArrayBuffer;
  fileName: string;
  mime: "image/webp";
}

export async function compressImage(file: File): Promise<CompressedImage> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(
    1,
    IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height),
  );
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas-unavailable");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  for (let i = 0, q = IMAGE_QUALITY_START; i < IMAGE_QUALITY_STEPS; i++, q *= 0.9) {
    const blob = await canvasToBlob(canvas, IMAGE_MIME, q);
    if (!blob) throw new Error("webp-unsupported");
    if (blob.size <= IMAGE_MAX_BYTES) {
      const base = file.name.replace(/\.[^.]*$/, "") || "image";
      return {
        bytes: await blob.arrayBuffer(),
        fileName: `${base}.webp`.slice(0, 64),
        mime: "image/webp",
      };
    }
  }
  throw new Error("image-too-large");
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => resolve(b), type, quality);
    canvas.onerror = () => reject(new Error("canvas-error"));
  });
}

/** base64 → objectURL（表示用。破棄時は revoke を callers 側で実施） */
export function bytesToObjectUrl(bytes: ArrayBuffer, mime: string): string {
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
