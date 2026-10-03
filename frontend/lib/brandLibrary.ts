import { validateImageUpload } from "./productProcessing";

export interface SavedBrand {
  display_name: string;
  remove_background: boolean;
  original_url: string;
  display_url: string;
}

export interface BrandLookup {
  found: boolean;
  key: string;
  brand?: SavedBrand;
}

export function normalizeBrand(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "").replace(/-+/g, "-");
  if (!key || key.length > 80) throw new Error("请输入有效品牌名称（英文字母或数字）。");
  return key;
}

function endpoint(brand: string): string {
  return `/api/brands/${encodeURIComponent(normalizeBrand(brand))}`;
}

async function jsonResponse(response: Response): Promise<BrandLookup> {
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data && typeof data === "object" && "detail" in data && typeof data.detail === "string" ? data.detail : null;
    throw new Error(detail ?? "本地品牌库暂时不可用，请检查后端。 ");
  }
  if (!data || typeof data !== "object" || !("found" in data) || typeof data.found !== "boolean" || !("key" in data) || typeof data.key !== "string") {
    throw new Error("品牌库返回了无效结果。 ");
  }
  if (data.found && (!("brand" in data) || !data.brand || typeof data.brand !== "object" ||
      !("display_url" in data.brand) || typeof data.brand.display_url !== "string" ||
      !("original_url" in data.brand) || typeof data.brand.original_url !== "string" ||
      !("remove_background" in data.brand) || typeof data.brand.remove_background !== "boolean")) {
    throw new Error("品牌库返回了无效 Logo 信息。 ");
  }
  return data as BrandLookup;
}

export async function lookupBrand(brand: string): Promise<BrandLookup> {
  let response: Response;
  try { response = await fetch(endpoint(brand), { cache: "no-store" }); }
  catch { throw new Error("本地品牌库不可用，请先启动后端。 "); }
  return jsonResponse(response);
}

export async function fetchSavedOriginal(saved: SavedBrand): Promise<File> {
  let response: Response;
  try { response = await fetch(saved.original_url, { cache: "no-store" }); }
  catch { throw new Error("无法加载已保存 Logo 的原始图片。 "); }
  if (!response.ok) throw new Error("无法加载已保存 Logo 的原始图片。 ");
  const type = response.headers.get("content-type")?.split(";")[0] ?? "";
  const blob = await response.blob();
  const file = new File([blob], "saved-logo", { type });
  validateImageUpload(file);
  return file;
}

export async function persistBrand(brand: string, original: File, displayed: File, removeBackground: boolean, replace: boolean, displayName = brand): Promise<BrandLookup> {
  validateImageUpload(original);
  if (removeBackground) validateImageUpload(displayed);
  const form = new FormData();
  form.append("display_name", displayName.trim());
  form.append("remove_background", String(removeBackground));
  form.append("file", original);
  if (removeBackground) form.append("processed_file", displayed);
  let response: Response;
  try { response = await fetch(endpoint(brand), { method: replace ? "PUT" : "POST", body: form }); }
  catch { throw new Error("无法连接本地品牌库，Logo 尚未保存。 "); }
  return jsonResponse(response);
}
