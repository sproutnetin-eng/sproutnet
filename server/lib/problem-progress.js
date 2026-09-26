'use strict';

const PROBLEM_PROGRESS_BUCKET = 'submission-progress';
const PROBLEM_PROGRESS_MAX_BYTES = 15 * 1024 * 1024;
const PROGRESS_FILES_MARKER_START = '<!--progress-files';
const PROGRESS_FILES_MARKER_END = 'progress-files-->';

const PROBLEM_PROGRESS_ALLOWED_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.ms-powerpoint',
  'application/vnd.ms-excel',
  'text/csv',
  'application/zip',
  'application/x-zip-compressed',
  'image/jpeg',
  'image/png',
  'image/webp',
];

const PROBLEM_PROGRESS_ACCEPT = PROBLEM_PROGRESS_ALLOWED_TYPES.join(',');

function getProblemProgressUploadError(file) {
  if (!PROBLEM_PROGRESS_ALLOWED_TYPES.includes(file.type)) {
    return 'Use PDF, Office, CSV, ZIP, JPG, PNG, or WebP files for progress uploads.';
  }

  if (file.size > PROBLEM_PROGRESS_MAX_BYTES) {
    return 'Each progress upload must be 15 MB or smaller.';
  }

  return null;
}

function sanitizeProblemProgressFileName(name) {
  const lastDot = name.lastIndexOf('.');
  const base = (lastDot >= 0 ? name.slice(0, lastDot) : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'progress-file';
  const extension = (lastDot >= 0 ? name.slice(lastDot + 1) : 'bin')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 10) || 'bin';

  return `${base}.${extension}`;
}

function serializeProgressUploads(text, files) {
  const cleanText = text.trim();
  if (files.length === 0) return cleanText;

  const serializedFiles = JSON.stringify(files);
  return [
    cleanText,
    '',
    PROGRESS_FILES_MARKER_START,
    serializedFiles,
    PROGRESS_FILES_MARKER_END,
  ].filter(Boolean).join('\n');
}

function parseProgressUploads(value) {
  if (!value) {
    return {
      text: '',
      files: [],
    };
  }

  const startIndex = value.indexOf(PROGRESS_FILES_MARKER_START);
  const endIndex = value.indexOf(PROGRESS_FILES_MARKER_END);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return {
      text: value,
      files: [],
    };
  }

  const text = value.slice(0, startIndex).trimEnd();
  const rawPayload = value
    .slice(startIndex + PROGRESS_FILES_MARKER_START.length, endIndex)
    .trim();

  try {
    const parsed = JSON.parse(rawPayload);
    const files = Array.isArray(parsed)
      ? parsed.filter((item) => (
          typeof item?.name === 'string' &&
          typeof item?.url === 'string'
        ))
      : [];

    return { text, files };
  } catch {
    return {
      text,
      files: [],
    };
  }
}

module.exports = {
  PROBLEM_PROGRESS_BUCKET,
  PROBLEM_PROGRESS_MAX_BYTES,
  PROBLEM_PROGRESS_ALLOWED_TYPES,
  PROBLEM_PROGRESS_ACCEPT,
  getProblemProgressUploadError,
  sanitizeProblemProgressFileName,
  serializeProgressUploads,
  parseProgressUploads,
};
