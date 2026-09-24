'use strict';

const PROBLEM_THUMBNAIL_BUCKET = 'problem-thumbnails';
const PROBLEM_THUMBNAIL_MAX_BYTES = 5 * 1024 * 1024;
const PROBLEM_THUMBNAIL_FALLBACK_PREFIX = 'thumbnail::';
const PROBLEM_THUMBNAIL_ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];
const PROBLEM_THUMBNAIL_ACCEPT = PROBLEM_THUMBNAIL_ALLOWED_TYPES.join(',');

function getProblemThumbnailError(file) {
  if (!PROBLEM_THUMBNAIL_ALLOWED_TYPES.includes(file.type)) {
    return 'Use a JPG, PNG, WebP, or GIF image for the thumbnail.';
  }

  if (file.size > PROBLEM_THUMBNAIL_MAX_BYTES) {
    return 'Thumbnail image must be 5 MB or smaller.';
  }

  return null;
}

function normalizeProblemThumbnailUrl(value) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function sanitizeProblemThumbnailFileName(name) {
  const lastDot = name.lastIndexOf('.');
  const base = (lastDot >= 0 ? name.slice(0, lastDot) : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'thumbnail';
  const extension = (lastDot >= 0 ? name.slice(lastDot + 1) : 'jpg')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8) || 'jpg';

  return `${base}.${extension}`;
}

function encodeProblemThumbnailFallback(url) {
  if (!url) return null;
  return `${PROBLEM_THUMBNAIL_FALLBACK_PREFIX}${url}`;
}

function decodeProblemThumbnailFallback(value) {
  if (typeof value !== 'string') return null;
  if (!value.startsWith(PROBLEM_THUMBNAIL_FALLBACK_PREFIX)) return null;

  const url = value.slice(PROBLEM_THUMBNAIL_FALLBACK_PREFIX.length).trim();
  return normalizeProblemThumbnailUrl(url);
}

function isMissingProblemThumbnailColumnError(message) {
  if (!message) return false;

  const normalized = message.toLowerCase();

  return (
    normalized.includes('thumbnail_url') &&
    (
      normalized.includes('schema cache') ||
      normalized.includes('does not exist') ||
      normalized.includes('unknown column')
    )
  );
}

module.exports = {
  PROBLEM_THUMBNAIL_BUCKET,
  PROBLEM_THUMBNAIL_MAX_BYTES,
  PROBLEM_THUMBNAIL_ALLOWED_TYPES,
  PROBLEM_THUMBNAIL_ACCEPT,
  getProblemThumbnailError,
  normalizeProblemThumbnailUrl,
  sanitizeProblemThumbnailFileName,
  encodeProblemThumbnailFallback,
  decodeProblemThumbnailFallback,
  isMissingProblemThumbnailColumnError,
};
