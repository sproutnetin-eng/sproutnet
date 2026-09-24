'use strict';

const BLOGS_SETUP_SQL_PATH = 'supabase/migrations/20260314_create_blogs.sql';
const BLOGS_SETUP_REQUIRED_MESSAGE = `Blogs is not set up yet. Run the SQL in ${BLOGS_SETUP_SQL_PATH} and refresh this page.`;
const BLOGS_REPLIES_SETUP_SQL_PATH = 'supabase/migrations/20260315_add_blog_comment_parent.sql';
const BLOGS_REPLIES_SETUP_REQUIRED_MESSAGE = `Replies are not set up yet. Run the SQL in ${BLOGS_REPLIES_SETUP_SQL_PATH} and refresh this page.`;

function isMissingBlogTablesError(message) {
  if (!message) return false;

  const normalized = message.toLowerCase();
  const mentionsBlogTables = ['blog_posts', 'blog_comments', 'blog_post_likes']
    .some((table) => normalized.includes(table));
  const missingTableIndicators = (
    normalized.includes('schema cache') ||
    normalized.includes('does not exist') ||
    normalized.includes('unknown table') ||
    normalized.includes('relation')
  );

  return mentionsBlogTables && missingTableIndicators;
}

function isMissingBlogCommentParentColumnError(message) {
  if (!message) return false;

  const normalized = message.toLowerCase();

  return (
    normalized.includes('parent_comment_id') &&
    (
      normalized.includes('schema cache') ||
      normalized.includes('does not exist') ||
      normalized.includes('unknown column')
    )
  );
}

function normalizeBlogSetupError(message) {
  if (isMissingBlogTablesError(message)) {
    return BLOGS_SETUP_REQUIRED_MESSAGE;
  }

  return message ?? 'Could not load the blog feed.';
}

function isBlogBodyEmpty(bodyJson) {
  if (!bodyJson) return true;

  // If it's a string, try to parse it first (since body is passed as a string from the API)
  if (typeof bodyJson === 'string') {
    const trimmed = bodyJson.trim();
    if (!trimmed) return true;
    try {
      bodyJson = JSON.parse(trimmed);
    } catch {
      // If it's not valid JSON, treat it as a plain string (which is not empty since trim() length > 0)
      return false;
    }
  }

  // If we have a text node
  if (bodyJson.type === 'text') {
    return !bodyJson.text || bodyJson.text.trim().length === 0;
  }

  // If it is an image node
  if (bodyJson.type === 'image') {
    return !bodyJson.attrs?.src;
  }

  // If it has children (like a document, paragraph, list, etc.)
  if (bodyJson.content && Array.isArray(bodyJson.content) && bodyJson.content.length > 0) {
    return bodyJson.content.every((child) => isBlogBodyEmpty(child));
  }

  // Any other node type without children is considered empty
  return true;
}

function getBlogBodyText(bodyJson) {
  if (!bodyJson) return '';

  if (typeof bodyJson === 'string') {
    const trimmed = bodyJson.trim();
    if (!trimmed) return '';
    try {
      bodyJson = JSON.parse(trimmed);
    } catch {
      // If it's not valid JSON, treat it as plain text
      return trimmed;
    }
  }

  // If we have a text node
  if (bodyJson.type === 'text') {
    return bodyJson.text ?? '';
  }

  // Recursively gather text from all children
  let text = '';
  if (bodyJson.content && Array.isArray(bodyJson.content)) {
    const childrenText = bodyJson.content.map((child) => getBlogBodyText(child)).filter(Boolean);

    if (bodyJson.type === 'paragraph' || bodyJson.type === 'heading') {
      text = childrenText.join('') + '\n';
    } else if (bodyJson.type === 'listItem') {
      text = '• ' + childrenText.join('') + '\n';
    } else {
      text = childrenText.join(' ');
    }
  }

  return text.trim();
}

module.exports = {
  BLOGS_SETUP_SQL_PATH,
  BLOGS_SETUP_REQUIRED_MESSAGE,
  BLOGS_REPLIES_SETUP_SQL_PATH,
  BLOGS_REPLIES_SETUP_REQUIRED_MESSAGE,
  isMissingBlogTablesError,
  isMissingBlogCommentParentColumnError,
  normalizeBlogSetupError,
  isBlogBodyEmpty,
  getBlogBodyText,
};
