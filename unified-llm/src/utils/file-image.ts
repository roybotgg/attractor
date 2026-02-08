const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function inferMediaType(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) {
    return "application/octet-stream";
  }
  const ext = path.slice(dot).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

export function isLocalFilePath(url: string): boolean {
  return url.startsWith("/") || url.startsWith("./") || url.startsWith("~/");
}

function expandTilde(path: string): string {
  if (!path.startsWith("~/")) {
    return path;
  }
  const home = typeof process !== "undefined" ? process.env["HOME"] : undefined;
  if (!home) {
    return path;
  }
  return home + path.slice(1);
}

export interface FileImageResult {
  data: Uint8Array;
  mediaType: string;
}

export async function readImageFile(path: string): Promise<FileImageResult> {
  const resolved = expandTilde(path);
  const file = Bun.file(resolved);
  const buffer = await file.arrayBuffer();
  return {
    data: new Uint8Array(buffer),
    mediaType: inferMediaType(resolved),
  };
}
