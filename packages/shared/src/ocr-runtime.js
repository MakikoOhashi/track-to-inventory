export const ALLOWED_OCR_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
];

export const ALLOWED_OCR_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "pdf", "txt"];
export const MAX_UPLOAD_FILE_SIZE = 10 * 1024 * 1024;

const INVALID_PATH_SEGMENT_PATTERN = /[\\/:*?"<>|]/;
const INVALID_STORAGE_PATH_PATTERN = /[\\:*?"<>|]/;

/**
 * @param {string | undefined | null} fileName
 */
export function getFileExtension(fileName) {
  return fileName?.split(".").pop()?.toLowerCase() ?? "";
}

/**
 * @param {number} fileSize
 */
export function formatFileSizeInMb(fileSize) {
  return `${(fileSize / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * @param {string} value
 */
export function hasInvalidPathSegment(value) {
  return INVALID_PATH_SEGMENT_PATTERN.test(value);
}

/**
 * @param {string} value
 */
export function isUnsafeStoragePath(value) {
  return (
    INVALID_STORAGE_PATH_PATTERN.test(value) ||
    value.includes("..") ||
    value.startsWith("/")
  );
}

/**
 * @param {string} siNumber
 * @param {string} type
 * @param {string} fileExt
 */
export function buildShipmentFilePath(siNumber, type, fileExt) {
  return `${siNumber}/${type}.${fileExt}`;
}

/**
 * @param {{ size: number; name: string; type: string }} file
 */
export function validateUploadFile(file) {
  if (file.size === 0) {
    throw new Error("空のファイルはアップロードできません");
  }

  if (file.size > MAX_UPLOAD_FILE_SIZE) {
    throw new Error(
      `ファイルサイズは最大10MBまでです（現在のサイズ: ${formatFileSizeInMb(file.size)}）`,
    );
  }

  const fileExt = getFileExtension(file.name);
  if (
    !ALLOWED_OCR_EXTENSIONS.includes(fileExt) ||
    !ALLOWED_OCR_MIME_TYPES.includes(file.type)
  ) {
    throw new Error("許可されていないファイル形式です");
  }

  return fileExt;
}

/**
 * @param {string | string[] | undefined | null} filePaths
 */
export function normalizeFilePaths(filePaths) {
  return Array.isArray(filePaths) ? filePaths : [filePaths];
}
