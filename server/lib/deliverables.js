'use strict';

const DELIVERABLES_BUCKET = 'deliverables';
const DELIVERABLE_MAX_BYTES = 25 * 1024 * 1024;
const MAX_DELIVERABLES = 5;

function isDeliverableItem(value) {
  const item = value;
  return (
    !!item &&
    (item.kind === 'link' || item.kind === 'file') &&
    typeof item.label === 'string' &&
    typeof item.url === 'string'
  );
}

function parseDeliverables(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(isDeliverableItem);
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function sanitizeDeliverableFileName(name) {
  const lastDot = name.lastIndexOf('.');
  const base = (lastDot >= 0 ? name.slice(0, lastDot) : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'file';
  const extension = (lastDot >= 0 ? name.slice(lastDot + 1) : 'bin')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12) || 'bin';

  return `${base}.${extension}`;
}

module.exports = {
  DELIVERABLES_BUCKET,
  DELIVERABLE_MAX_BYTES,
  MAX_DELIVERABLES,
  isDeliverableItem,
  parseDeliverables,
  isValidHttpUrl,
  sanitizeDeliverableFileName,
};
