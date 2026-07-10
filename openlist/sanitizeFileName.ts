import path from "node:path";

/**
 * 将 Telegram 提供的文件名压缩为一个安全路径段。
 * 先统一 Windows/Unix 分隔符再取 basename，并拒绝特殊点目录。
 */
export function sanitizeMediaFileName(input: unknown): string {
  const normalized = String(input ?? "")
    .replace(/\\/g, "/")
    .replace(/[\u0000-\u001f\u007f]/g, "");
  const base = path.posix.basename(normalized).trim().replace(/[. ]+$/g, "");
  const extension = path.posix.extname(base).slice(0, 32);
  const stem = path.posix.basename(base, extension).trim();
  if (!stem || stem === "." || stem === "..") {
    return `file_${Date.now()}${extension}`;
  }
  const maxStemLength = Math.max(1, 255 - extension.length);
  return `${stem.slice(0, maxStemLength)}${extension}`;
}
