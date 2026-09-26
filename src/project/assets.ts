import type { ProjectAsset } from "../types/index.ts";

export const SUPPORTED_ASSET_MIMES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

export function assetMime(path: string): string | undefined {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return SUPPORTED_ASSET_MIMES[extension];
}

export function isAssetPath(path: string): boolean {
  return path.startsWith("assets/") && Boolean(assetMime(path));
}

function dataUrlBlob(value: string, fallbackMime: string): Blob | undefined {
  if (!value.startsWith("data:")) return undefined;
  const comma = value.indexOf(",");
  if (comma < 0) return undefined;
  const header = value.slice(5, comma);
  const body = value.slice(comma + 1);
  const [mime] = header.split(";");
  const type = mime || fallbackMime;
  if (header.includes(";base64")) {
    try {
      const binary = atob(body);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return new Blob([bytes], { type });
    } catch {
      return undefined;
    }
  }
  try {
    return new Blob([decodeURIComponent(body)], { type });
  } catch {
    return undefined;
  }
}

export function assetFromValue(path: string, value: string): ProjectAsset | undefined {
  const mime = assetMime(path);
  if (!mime || value.startsWith("blob:")) return undefined;
  const data = dataUrlBlob(value, mime) || new Blob([value], { type: mime });
  return { path, mime, size: data.size, data };
}

export function assetFromBlob(path: string, data: Blob, mime = assetMime(path)): ProjectAsset {
  return { path, mime: mime || data.type || "application/octet-stream", size: data.size, data };
}

export class AssetResolver {
  private readonly urls = new Map<string, string>();
  private readonly missing = new Set<string>();

  constructor(
    private readonly assets: Record<string, ProjectAsset>,
    private readonly onMissing?: (path: string) => void,
  ) {}

  url(path: string): string | undefined {
    const existing = this.urls.get(path);
    if (existing) return existing;
    const asset = this.assets[path];
    if (!asset) {
      if (/^(data:|https?:|blob:)/.test(path)) return path;
      if (!this.missing.has(path)) {
        this.missing.add(path);
        this.onMissing?.(path);
      }
      return undefined;
    }
    const url = URL.createObjectURL(asset.data);
    this.urls.set(path, url);
    return url;
  }

  get(path: string): ProjectAsset | undefined {
    return this.assets[path];
  }

  revoke(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.missing.clear();
  }
}
