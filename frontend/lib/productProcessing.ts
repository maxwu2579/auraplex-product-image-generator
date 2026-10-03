const PROCESS_URL = "/api/images/remove-background";
const DETECT_URL = "/api/images/detect-subjects";
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function validateImageUpload(file: File): void {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error(`${file.name}: 仅支持 JPG、PNG 或 WEBP。`);
  }
  if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name}: 图片不能超过 10 MB。`);
}

export async function prepareSupportingImage(file: File, removeBackground: boolean): Promise<File> {
  validateImageUpload(file);
  if (!removeBackground) return file;
  const png = await removeProductBackground(file);
  return new File([png], `${file.name}.png`, { type: "image/png" });
}

async function postImage(file: File, url: string): Promise<Response> {
  const form = new FormData();
  form.append("file", file);

  let response: Response;
  try {
    response = await fetch(url, { method: "POST", body: form });
  } catch {
    throw new Error("图像处理服务不可用，请先启动本机后端。");
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail = body && typeof body === "object" && "detail" in body && typeof body.detail === "string"
      ? body.detail : null;
    throw new Error(detail ?? (response.status >= 500
      ? "图像处理服务不可用，请检查本机后端。"
      : "无法处理这张图片。"));
  }

  return response;
}

export async function removeProductBackground(file: File): Promise<Blob> {
  const response = await postImage(file, PROCESS_URL);
  if (response.headers.get("content-type")?.split(";")[0] !== "image/png") {
    throw new Error("处理服务返回了无效的图片格式。");
  }
  const png = await response.blob();
  if (!png.size) throw new Error("处理服务返回了空图片。");
  return png;
}

export interface EncodedSubjectImage {
  id?: string;
  pngBase64: string;
  width: number;
  height: number;
  area?: number;
  small?: boolean;
}

export interface DetectionResult {
  whole: EncodedSubjectImage;
  candidates: EncodedSubjectImage[];
  warning: string | null;
}

export async function detectProductSubjects(file: File): Promise<DetectionResult> {
  validateImageUpload(file);
  const response = await postImage(file, DETECT_URL);
  if (response.headers.get("content-type")?.split(";")[0] !== "application/json") {
    throw new Error("主体检测服务返回了无效结果。");
  }
  const result: unknown = await response.json().catch(() => null);
  if (!result || typeof result !== "object" || !("whole" in result) || !("candidates" in result) ||
      !Array.isArray(result.candidates) || typeof result.whole !== "object" || result.whole === null ||
      !("pngBase64" in result.whole) || typeof result.whole.pngBase64 !== "string" || !result.whole.pngBase64) {
    throw new Error("主体检测服务返回了无效结果。");
  }
  return result as DetectionResult;
}

export function pngBase64ToFile(encoded: string, name: string): File {
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  return new File([bytes], name, { type: "image/png" });
}
