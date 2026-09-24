'use strict';

const { promises: fs } = require('node:fs');
const path = require('node:path');

const BLOGS_LOCAL_FALLBACK_ENABLED = process.env.BLOGS_ALLOW_LOCAL_FALLBACK !== 'false';

const DATA_DIR = process.env.VERCEL
  ? '/tmp/.data'
  : path.join(__dirname, '..', '..', '.data');
const BLOGS_LOCAL_DATA_PATH = path.join(DATA_DIR, 'blogs.json');

function normalizeLocalData(value) {
  if (!value || typeof value !== 'object') {
    return { posts: [], comments: [], likes: [] };
  }

  const data = value;

  return {
    posts: Array.isArray(data.posts) ? data.posts : [],
    comments: Array.isArray(data.comments) ? data.comments : [],
    likes: Array.isArray(data.likes) ? data.likes : [],
  };
}

async function readLocalData() {
  try {
    const raw = await fs.readFile(BLOGS_LOCAL_DATA_PATH, 'utf8');
    return normalizeLocalData(JSON.parse(raw));
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return { posts: [], comments: [], likes: [] };
    }
    throw err;
  }
}

async function writeLocalData(data) {
  await fs.mkdir(path.dirname(BLOGS_LOCAL_DATA_PATH), { recursive: true });
  await fs.writeFile(BLOGS_LOCAL_DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
}

async function getLocalBlogRows() {
  return readLocalData();
}

async function createLocalBlogPost(params) {
  const data = await readLocalData();
  const post = {
    id: crypto.randomUUID(),
    author_id: params.authorId,
    title: params.title,
    body: params.body,
    post_type: params.postType,
    created_at: new Date().toISOString(),
    cover_image: params.coverImage ?? null,
    slug: params.slug ?? null,
    excerpt: params.excerpt ?? null,
    tags: params.tags ?? [],
    category: params.category ?? null,
    seo_title: params.seoTitle ?? null,
    seo_description: params.seoDescription ?? null,
    status: params.status ?? 'published',
  };

  data.posts.unshift(post);
  await writeLocalData(data);

  return post;
}

async function updateLocalBlogPost(params) {
  const data = await readLocalData();
  const index = data.posts.findIndex((post) => post.id === params.postId);

  if (index < 0) {
    throw new Error('Post not found.');
  }

  const post = data.posts[index];
  if (post.author_id !== params.authorId) {
    throw new Error('Forbidden');
  }

  if (typeof params.title === 'string') {
    post.title = params.title;
  }

  if (typeof params.body === 'string') {
    post.body = params.body;
  }

  if (typeof params.postType === 'string') {
    post.post_type = params.postType;
  }

  if (params.coverImage !== undefined) {
    post.cover_image = params.coverImage;
  }

  if (params.slug !== undefined) {
    post.slug = params.slug;
  }

  if (params.excerpt !== undefined) {
    post.excerpt = params.excerpt;
  }

  if (params.tags !== undefined) {
    post.tags = params.tags;
  }

  if (params.category !== undefined) {
    post.category = params.category;
  }

  if (params.seoTitle !== undefined) {
    post.seo_title = params.seoTitle;
  }

  if (params.seoDescription !== undefined) {
    post.seo_description = params.seoDescription;
  }

  if (params.status !== undefined) {
    post.status = params.status;
  }

  data.posts[index] = post;
  await writeLocalData(data);
  return post;
}

async function removeLocalBlogPost(params) {
  const data = await readLocalData();
  const index = data.posts.findIndex((post) => post.id === params.postId);

  if (index < 0) {
    throw new Error('Post not found.');
  }

  const post = data.posts[index];
  if (post.author_id !== params.authorId) {
    throw new Error('Forbidden');
  }

  data.posts.splice(index, 1);
  data.comments = data.comments.filter((comment) => comment.post_id !== params.postId);
  data.likes = data.likes.filter((like) => like.post_id !== params.postId);
  await writeLocalData(data);
}

async function addLocalBlogComment(params) {
  const data = await readLocalData();
  const postExists = data.posts.some((post) => post.id === params.postId);

  if (!postExists) {
    throw new Error('Post not found.');
  }

  if (params.parentCommentId) {
    const parent = data.comments.find((comment) => comment.id === params.parentCommentId);
    if (!parent || parent.post_id !== params.postId) {
      throw new Error('Parent comment not found.');
    }
  }

  const comment = {
    id: crypto.randomUUID(),
    post_id: params.postId,
    author_id: params.authorId,
    body: params.body,
    created_at: new Date().toISOString(),
    parent_comment_id: params.parentCommentId ?? null,
  };

  data.comments.push(comment);
  await writeLocalData(data);

  return comment;
}

async function removeLocalBlogComment(params) {
  const data = await readLocalData();
  const index = data.comments.findIndex((comment) => comment.id === params.commentId);

  if (index < 0) {
    throw new Error('Comment not found.');
  }

  const comment = data.comments[index];
  if (comment.author_id !== params.authorId) {
    throw new Error('Forbidden');
  }

  const idsToRemove = new Set([params.commentId]);
  let found = true;
  while (found) {
    found = false;
    for (const entry of data.comments) {
      if (entry.parent_comment_id && idsToRemove.has(entry.parent_comment_id) && !idsToRemove.has(entry.id)) {
        idsToRemove.add(entry.id);
        found = true;
      }
    }
  }

  data.comments = data.comments.filter((entry) => !idsToRemove.has(entry.id));
  await writeLocalData(data);
}

async function toggleLocalBlogLike(params) {
  const data = await readLocalData();
  const index = data.likes.findIndex(
    (like) => like.post_id === params.postId && like.user_id === params.userId
  );

  let liked = false;
  if (index >= 0) {
    data.likes.splice(index, 1);
    liked = false;
  } else {
    data.likes.push({ post_id: params.postId, user_id: params.userId });
    liked = true;
  }

  await writeLocalData(data);
  return { liked };
}

module.exports = {
  BLOGS_LOCAL_FALLBACK_ENABLED,
  getLocalBlogRows,
  createLocalBlogPost,
  updateLocalBlogPost,
  removeLocalBlogPost,
  addLocalBlogComment,
  removeLocalBlogComment,
  toggleLocalBlogLike,
};
