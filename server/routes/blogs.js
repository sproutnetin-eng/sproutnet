const express = require('express');
const router = express.Router();
const { randomUUID } = require('node:crypto');
const { authRequired, optionalAuth } = require('../middleware/auth');
const { getAdmin } = require('../supabase');
const upload = require('../middleware/upload');

// ---------------------------------------------------------------------------
// Helpers ported from the original blogs lib (pure functions, no framework dependency)
// ---------------------------------------------------------------------------
const BLOGS_SETUP_SQL_PATH = 'supabase/migrations/20260314_create_blogs.sql';
const BLOGS_SETUP_REQUIRED_MESSAGE =
  `Blogs is not set up yet. Run the SQL in ${BLOGS_SETUP_SQL_PATH} and refresh this page.`;

function isMissingBlogTablesError(message) {
  if (!message) return false;
  const normalized = String(message).toLowerCase();
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
  const normalized = String(message).toLowerCase();
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
  if (typeof bodyJson === 'string') {
    const trimmed = bodyJson.trim();
    if (!trimmed) return true;
    try {
      bodyJson = JSON.parse(trimmed);
    } catch (_e) {
      return false;
    }
  }
  if (bodyJson.type === 'text') {
    return !bodyJson.text || bodyJson.text.trim().length === 0;
  }
  if (bodyJson.type === 'image') {
    return !bodyJson.attrs?.src;
  }
  if (bodyJson.content && Array.isArray(bodyJson.content) && bodyJson.content.length > 0) {
    return bodyJson.content.every((child) => isBlogBodyEmpty(child));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Local JSON fallback store.
// Prefers server/lib/blogs-local (same named exports as lib/blogs-local.server.ts);
// if it is missing, uses an inline minimal JSON-file store at .data/blogs.json.
// ---------------------------------------------------------------------------
function createInlineLocalStore() {
  const fs = require('node:fs').promises;
  const path = require('node:path');
  const { randomUUID: uuid } = require('node:crypto');

  const DATA_DIR = process.env.VERCEL ? '/tmp/.data' : path.join(process.cwd(), '.data');
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

  return {
    BLOGS_LOCAL_FALLBACK_ENABLED: process.env.BLOGS_ALLOW_LOCAL_FALLBACK !== 'false',

    async getLocalBlogRows() {
      return readLocalData();
    },

    async createLocalBlogPost(params) {
      const data = await readLocalData();
      const post = {
        id: uuid(),
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
    },

    async updateLocalBlogPost(params) {
      const data = await readLocalData();
      const index = data.posts.findIndex((post) => post.id === params.postId);
      if (index < 0) throw new Error('Post not found.');
      const post = data.posts[index];
      if (post.author_id !== params.authorId) throw new Error('Forbidden');
      if (typeof params.title === 'string') post.title = params.title;
      if (typeof params.body === 'string') post.body = params.body;
      if (typeof params.postType === 'string') post.post_type = params.postType;
      if (params.coverImage !== undefined) post.cover_image = params.coverImage;
      if (params.slug !== undefined) post.slug = params.slug;
      if (params.excerpt !== undefined) post.excerpt = params.excerpt;
      if (params.tags !== undefined) post.tags = params.tags;
      if (params.category !== undefined) post.category = params.category;
      if (params.seoTitle !== undefined) post.seo_title = params.seoTitle;
      if (params.seoDescription !== undefined) post.seo_description = params.seoDescription;
      if (params.status !== undefined) post.status = params.status;
      data.posts[index] = post;
      await writeLocalData(data);
      return post;
    },

    async removeLocalBlogPost(params) {
      const data = await readLocalData();
      const index = data.posts.findIndex((post) => post.id === params.postId);
      if (index < 0) throw new Error('Post not found.');
      const post = data.posts[index];
      if (post.author_id !== params.authorId) throw new Error('Forbidden');
      data.posts.splice(index, 1);
      data.comments = data.comments.filter((comment) => comment.post_id !== params.postId);
      data.likes = data.likes.filter((like) => like.post_id !== params.postId);
      await writeLocalData(data);
    },

    async addLocalBlogComment(params) {
      const data = await readLocalData();
      const postExists = data.posts.some((post) => post.id === params.postId);
      if (!postExists) throw new Error('Post not found.');
      if (params.parentCommentId) {
        const parent = data.comments.find((comment) => comment.id === params.parentCommentId);
        if (!parent || parent.post_id !== params.postId) {
          throw new Error('Parent comment not found.');
        }
      }
      const comment = {
        id: uuid(),
        post_id: params.postId,
        author_id: params.authorId,
        body: params.body,
        created_at: new Date().toISOString(),
        parent_comment_id: params.parentCommentId ?? null,
      };
      data.comments.push(comment);
      await writeLocalData(data);
      return comment;
    },

    async removeLocalBlogComment(params) {
      const data = await readLocalData();
      const index = data.comments.findIndex((comment) => comment.id === params.commentId);
      if (index < 0) throw new Error('Comment not found.');
      const comment = data.comments[index];
      if (comment.author_id !== params.authorId) throw new Error('Forbidden');
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
    },

    async toggleLocalBlogLike(params) {
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
    },
  };
}

let localStore;
try {
  localStore = require('../lib/blogs-local');
} catch (_e) {
  localStore = createInlineLocalStore();
}

const BLOGS_LOCAL_FALLBACK_ENABLED = typeof localStore.BLOGS_LOCAL_FALLBACK_ENABLED === 'boolean'
  ? localStore.BLOGS_LOCAL_FALLBACK_ENABLED
  : process.env.BLOGS_ALLOW_LOCAL_FALLBACK !== 'false';
const createLocalBlogPost = localStore.createLocalBlogPost.bind(localStore);
const removeLocalBlogPost = localStore.removeLocalBlogPost.bind(localStore);
const updateLocalBlogPost = localStore.updateLocalBlogPost.bind(localStore);
const getLocalBlogRows = localStore.getLocalBlogRows.bind(localStore);
const addLocalBlogComment = localStore.addLocalBlogComment.bind(localStore);
const removeLocalBlogComment = localStore.removeLocalBlogComment.bind(localStore);
const toggleLocalBlogLike = localStore.toggleLocalBlogLike.bind(localStore);

// ---------------------------------------------------------------------------
// Blog feed builder ported from lib/blogs.server.ts
// ---------------------------------------------------------------------------
function normalizePostType(value) {
  return value === 'question' ? 'question' : 'knowledge';
}

function sortByCreatedDesc(rows) {
  return [...rows].sort((a, b) => {
    const aTime = Date.parse(a.created_at);
    const bTime = Date.parse(b.created_at);
    return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
  });
}

async function buildFeedFromRows(params) {
  const orderedPosts = sortByCreatedDesc(params.posts).slice(0, 60);
  if (orderedPosts.length === 0) {
    return { posts: [], error: null, setupRequired: false };
  }

  const postIds = orderedPosts.map((post) => post.id);
  const comments = params.comments.filter((comment) => postIds.includes(comment.post_id));
  const likes = params.likes.filter((like) => postIds.includes(like.post_id));

  const userIds = Array.from(
    new Set([
      ...orderedPosts.map((post) => post.author_id),
      ...comments.map((comment) => comment.author_id),
      ...likes.map((like) => like.user_id),
    ].filter(Boolean))
  );

  let users = [];
  if (userIds.length > 0) {
    const { data: userRows, error: usersError } = await params.admin
      .from('users')
      .select('id, name, role, dept, year')
      .in('id', userIds);

    if (usersError) {
      return {
        posts: [],
        error: normalizeBlogSetupError(usersError.message),
        setupRequired: false,
      };
    }

    users = userRows ?? [];
  }

  const userById = new Map(users.map((user) => [user.id, user]));

  const commentsByPost = new Map();
  for (const comment of comments) {
    const list = commentsByPost.get(comment.post_id) ?? [];
    list.push({
      id: comment.id,
      body: comment.body,
      createdAt: comment.created_at,
      author: userById.get(comment.author_id) ?? null,
      parentId: comment.parent_comment_id ?? null,
    });
    commentsByPost.set(comment.post_id, list);
  }

  const likesByPost = new Map();
  for (const like of likes) {
    const list = likesByPost.get(like.post_id) ?? [];
    list.push(like);
    likesByPost.set(like.post_id, list);
  }

  return {
    posts: orderedPosts.map((post) => {
      const postComments = commentsByPost.get(post.id) ?? [];
      const postLikes = likesByPost.get(post.id) ?? [];
      const likeUsers = postLikes
        .map((like) => userById.get(like.user_id))
        .filter(Boolean);

      return {
        id: post.id,
        title: post.title,
        body: post.body,
        postType: normalizePostType(post.post_type),
        createdAt: post.created_at,
        author: userById.get(post.author_id) ?? null,
        likesCount: postLikes.length,
        likeUsers,
        commentsCount: postComments.length,
        likedByViewer: Boolean(params.viewerId && postLikes.some((like) => like.user_id === params.viewerId)),
        comments: postComments,
        cover_image: post.cover_image,
        excerpt: post.excerpt,
      };
    }),
    error: null,
    setupRequired: false,
  };
}

async function getLocalBlogFeed(admin, viewerId) {
  const { posts, comments, likes } = await getLocalBlogRows();
  return buildFeedFromRows({ admin, posts, comments, likes, viewerId });
}

async function getBlogFeed(viewerId) {
  try {
    const admin = getAdmin();

    const { data: postRows, error: postsError } = await admin
      .from('blog_posts')
      .select('id, title, body, post_type, created_at, author_id, cover_image, excerpt')
      .order('created_at', { ascending: false })
      .limit(60);

    if (postsError) {
      if (isMissingBlogTablesError(postsError.message)) {
        if (BLOGS_LOCAL_FALLBACK_ENABLED) {
          return await getLocalBlogFeed(admin, viewerId);
        }
        return { posts: [], error: BLOGS_SETUP_REQUIRED_MESSAGE, setupRequired: true };
      }
      return { posts: [], error: normalizeBlogSetupError(postsError.message), setupRequired: false };
    }

    const posts = postRows ?? [];
    if (posts.length === 0) {
      return { posts: [], error: null, setupRequired: false };
    }

    const postIds = posts.map((post) => post.id);

    let commentsError = null;
    let commentRows = null;
    const [{ data: initialComments, error: initialError }, { data: likeRows, error: likesError }] = await Promise.all([
      admin
        .from('blog_comments')
        .select('id, post_id, body, created_at, author_id, parent_comment_id')
        .in('post_id', postIds)
        .order('created_at', { ascending: true }),
      admin
        .from('blog_post_likes')
        .select('post_id, user_id')
        .in('post_id', postIds),
    ]);

    if (initialError && isMissingBlogCommentParentColumnError(initialError.message)) {
      const { data: fallbackComments, error: fallbackError } = await admin
        .from('blog_comments')
        .select('id, post_id, body, created_at, author_id')
        .in('post_id', postIds)
        .order('created_at', { ascending: true });

      commentsError = fallbackError;
      commentRows = (fallbackComments ?? []).map((comment) => ({
        ...comment,
        parent_comment_id: null,
      }));
    } else {
      commentsError = initialError;
      commentRows = initialComments ?? [];
    }

    if (commentsError || likesError) {
      const missing = [commentsError, likesError].some(
        (error) => error && isMissingBlogTablesError(error.message)
      );

      if (missing && BLOGS_LOCAL_FALLBACK_ENABLED) {
        return await getLocalBlogFeed(admin, viewerId);
      }

      const error = commentsError ?? likesError;
      return {
        posts: [],
        error: normalizeBlogSetupError(error?.message),
        setupRequired: missing,
      };
    }

    const comments = commentRows ?? [];
    const likes = likeRows ?? [];

    return await buildFeedFromRows({ admin, posts, comments, likes, viewerId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network request failed.';
    return { posts: [], error: normalizeBlogSetupError(message), setupRequired: false };
  }
}

// ---------------------------------------------------------------------------
// GET /api/blogs/posts — feed (?id absent) or single post with comments/likes
// ---------------------------------------------------------------------------
router.get('/api/blogs/posts', optionalAuth, async (req, res) => {
  const user = req.user;
  const userId = user?.id ?? null;
  const postId = req.query.id || null;

  if (!postId) {
    const feed = await getBlogFeed(userId);
    return res.status(200).json({ posts: feed.posts, error: feed.error });
  }

  const admin = getAdmin();
  const { data: postRows, error: postError } = await admin
    .from('blog_posts')
    .select('*')
    .eq('id', postId)
    .limit(1);

  if (postError || !postRows?.length) {
    if (postError && isMissingBlogTablesError(postError.message) && BLOGS_LOCAL_FALLBACK_ENABLED) {
      const local = await getLocalBlogRows();
      const localPost = local.posts.find((p) => p.id === postId);
      if (!localPost) return res.status(404).json({ error: 'Post not found' });
      const feed = await getBlogFeed(userId);
      const found = feed.posts.find((p) => p.id === postId);
      if (found) return res.status(200).json({ post: found });
    }
    return res.status(404).json({ error: postError?.message || 'Post not found' });
  }

  // Fetch comments for this post
  const { data: commentRows } = await admin
    .from('blog_comments')
    .select('*')
    .eq('post_id', postId)
    .order('created_at', { ascending: true });

  // Fetch likes for this post
  const { data: likeRows } = await admin
    .from('blog_post_likes')
    .select('user_id')
    .eq('post_id', postId);

  const likedByViewer = user ? (likeRows || []).some((l) => l.user_id === user.id) : false;
  const likesCount = likeRows?.length || 0;

  // Fetch users (author + commenters)
  const allUserIds = new Set();
  allUserIds.add(postRows[0].author_id);
  if (commentRows) commentRows.forEach((c) => allUserIds.add(c.author_id));

  const { data: userRows } = await admin
    .from('users')
    .select('id, name, role, dept, year')
    .in('id', Array.from(allUserIds));

  const userMap = new Map((userRows || []).map((u) => [u.id, u]));

  const author = userMap.get(postRows[0].author_id) || null;

  const comments = (commentRows || []).map((c) => ({
    id: c.id,
    body: c.body,
    createdAt: c.created_at,
    author: userMap.get(c.author_id) || null,
    parentId: c.parent_comment_id || null,
  }));

  const post = {
    id: postRows[0].id,
    title: postRows[0].title,
    body: postRows[0].body,
    postType: postRows[0].post_type === 'question' ? 'question' : 'knowledge',
    createdAt: postRows[0].created_at,
    author: author ? { id: author.id, name: author.name, role: author.role, dept: author.dept, year: author.year } : null,
    likesCount,
    likedByViewer,
    commentsCount: comments.length,
    comments,
    cover_image: postRows[0].cover_image,
    excerpt: postRows[0].excerpt,
  };

  return res.status(200).json({ post });
});

// ---------------------------------------------------------------------------
// POST /api/blogs/posts — create a post
// ---------------------------------------------------------------------------
router.post('/api/blogs/posts', authRequired, async (req, res) => {
  const user = req.user;

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { data: profile } = await req.supabase
    .from('users')
    .select('id')
    .eq('id', user.id)
    .single();

  if (!profile) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : null;
  if (!payload) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const title = payload.title?.trim();
  const body = payload.body?.trim();
  const postType = payload.post_type === 'question' ? 'question' : 'knowledge';

  if (!title) {
    return res.status(400).json({ error: 'Title is required.' });
  }

  if (!body || isBlogBodyEmpty(body)) {
    return res.status(400).json({ error: 'Post body is required.' });
  }

  const admin = getAdmin();
  const { error } = await admin
    .from('blog_posts')
    .insert({
      author_id: user.id,
      title,
      body,
      post_type: postType,
      cover_image: payload.cover_image ?? null,
      slug: payload.slug?.trim() || null,
      excerpt: payload.excerpt?.trim() || null,
      tags: payload.tags || [],
      category: payload.category?.trim() || null,
      seo_title: payload.seo_title?.trim() || null,
      seo_description: payload.seo_description?.trim() || null,
      status: payload.status === 'draft' ? 'draft' : 'published',
    });

  if (error) {
    if (isMissingBlogTablesError(error.message) && BLOGS_LOCAL_FALLBACK_ENABLED) {
      try {
        await createLocalBlogPost({
          authorId: user.id,
          title,
          body,
          postType,
          coverImage: payload.cover_image ?? null,
          slug: payload.slug?.trim() || null,
          excerpt: payload.excerpt?.trim() || null,
          tags: payload.tags || [],
          category: payload.category?.trim() || null,
          seoTitle: payload.seo_title?.trim() || null,
          seoDescription: payload.seo_description?.trim() || null,
          status: payload.status === 'draft' ? 'draft' : 'published',
        });
        return res.status(200).json({ ok: true, local: true });
      } catch (localError) {
        const message = localError instanceof Error ? localError.message : 'Local blog store failed.';
        return res.status(500).json({ error: message });
      }
    }

    const message = normalizeBlogSetupError(error.message);
    const status = isMissingBlogTablesError(error.message) ? 503 : 400;
    return res.status(status).json({ error: message });
  }

  return res.status(200).json({ ok: true });
});

// ---------------------------------------------------------------------------
// PATCH /api/blogs/posts — edit own post
// ---------------------------------------------------------------------------
router.patch('/api/blogs/posts', authRequired, async (req, res) => {
  const user = req.user;

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { data: profile } = await req.supabase
    .from('users')
    .select('id')
    .eq('id', user.id)
    .single();

  if (!profile) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : null;
  if (!payload) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const postId = payload.post_id?.trim();
  const hasTitle = typeof payload.title === 'string';
  const hasBody = typeof payload.body === 'string';
  const hasPostType = typeof payload.post_type === 'string';

  if (!postId) {
    return res.status(400).json({ error: 'Missing post_id.' });
  }

  if (!hasTitle && !hasBody && !hasPostType) {
    return res.status(400).json({ error: 'No changes provided.' });
  }

  const title = payload.title?.trim();
  const body = payload.body?.trim();
  const postType = hasPostType ? (payload.post_type === 'question' ? 'question' : 'knowledge') : undefined;

  if (hasTitle && !title) {
    return res.status(400).json({ error: 'Title is required.' });
  }

  if (hasBody && (!body || isBlogBodyEmpty(body))) {
    return res.status(400).json({ error: 'Post body is required.' });
  }

  const admin = getAdmin();
  const { data: postRows, error: postError } = await admin
    .from('blog_posts')
    .select('id, author_id')
    .eq('id', postId)
    .limit(1);

  if (postError) {
    if (isMissingBlogTablesError(postError.message) && BLOGS_LOCAL_FALLBACK_ENABLED) {
      try {
        await updateLocalBlogPost({
          postId,
          authorId: user.id,
          title: hasTitle ? title : undefined,
          body: hasBody ? body : undefined,
          postType,
        });
        return res.status(200).json({ ok: true, local: true });
      } catch (localError) {
        const message = localError instanceof Error ? localError.message : 'Local blog store failed.';
        const status = message === 'Post not found.' ? 404 : message === 'Forbidden' ? 403 : 500;
        return res.status(status).json({ error: message });
      }
    }

    const message = normalizeBlogSetupError(postError.message);
    const status = isMissingBlogTablesError(postError.message) ? 503 : 400;
    return res.status(status).json({ error: message });
  }

  if (!postRows || postRows.length === 0) {
    return res.status(404).json({ error: 'Post not found.' });
  }

  if (postRows[0].author_id !== user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const updates = {};
  if (hasTitle && title) {
    updates.title = title;
  }
  if (hasBody && body) {
    updates.body = body;
  }
  if (hasPostType && postType) {
    updates.post_type = postType;
  }
  if (payload.cover_image !== undefined) {
    updates.cover_image = payload.cover_image;
  }
  if (payload.slug !== undefined) {
    updates.slug = payload.slug?.trim() || null;
  }
  if (payload.excerpt !== undefined) {
    updates.excerpt = payload.excerpt?.trim() || null;
  }
  if (payload.tags !== undefined) {
    updates.tags = payload.tags || [];
  }
  if (payload.category !== undefined) {
    updates.category = payload.category?.trim() || null;
  }
  if (payload.seo_title !== undefined) {
    updates.seo_title = payload.seo_title?.trim() || null;
  }
  if (payload.seo_description !== undefined) {
    updates.seo_description = payload.seo_description?.trim() || null;
  }
  if (payload.status !== undefined) {
    updates.status = payload.status === 'draft' ? 'draft' : 'published';
  }

  const { error } = await admin
    .from('blog_posts')
    .update(updates)
    .eq('id', postId)
    .eq('author_id', user.id);

  if (error) {
    if (isMissingBlogTablesError(error.message) && BLOGS_LOCAL_FALLBACK_ENABLED) {
      try {
        await updateLocalBlogPost({
          postId,
          authorId: user.id,
          title: hasTitle ? title : undefined,
          body: hasBody ? body : undefined,
          postType,
          coverImage: payload.cover_image,
          slug: payload.slug,
          excerpt: payload.excerpt,
          tags: payload.tags,
          category: payload.category,
          seoTitle: payload.seo_title,
          seoDescription: payload.seo_description,
          status: payload.status,
        });
        return res.status(200).json({ ok: true, local: true });
      } catch (localError) {
        const message = localError instanceof Error ? localError.message : 'Local blog store failed.';
        const status = message === 'Post not found.' ? 404 : message === 'Forbidden' ? 403 : 500;
        return res.status(status).json({ error: message });
      }
    }

    const message = normalizeBlogSetupError(error.message);
    const status = isMissingBlogTablesError(error.message) ? 503 : 400;
    return res.status(status).json({ error: message });
  }

  return res.status(200).json({ ok: true });
});

// ---------------------------------------------------------------------------
// DELETE /api/blogs/posts — delete own post
// ---------------------------------------------------------------------------
router.delete('/api/blogs/posts', authRequired, async (req, res) => {
  const user = req.user;

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { data: profile } = await req.supabase
    .from('users')
    .select('id')
    .eq('id', user.id)
    .single();

  if (!profile) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : null;
  if (!payload) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const postId = payload.post_id?.trim();
  if (!postId) {
    return res.status(400).json({ error: 'Missing post_id.' });
  }

  const admin = getAdmin();
  const { data: postRows, error: postError } = await admin
    .from('blog_posts')
    .select('id, author_id')
    .eq('id', postId)
    .limit(1);

  if (postError) {
    if (isMissingBlogTablesError(postError.message) && BLOGS_LOCAL_FALLBACK_ENABLED) {
      try {
        await removeLocalBlogPost({ postId, authorId: user.id });
        return res.status(200).json({ ok: true, local: true });
      } catch (localError) {
        const message = localError instanceof Error ? localError.message : 'Local blog store failed.';
        const status = message === 'Post not found.' ? 404 : message === 'Forbidden' ? 403 : 500;
        return res.status(status).json({ error: message });
      }
    }

    const message = normalizeBlogSetupError(postError.message);
    const status = isMissingBlogTablesError(postError.message) ? 503 : 400;
    return res.status(status).json({ error: message });
  }

  if (!postRows || postRows.length === 0) {
    return res.status(404).json({ error: 'Post not found.' });
  }

  if (postRows[0].author_id !== user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { error } = await admin
    .from('blog_posts')
    .delete()
    .eq('id', postId)
    .eq('author_id', user.id);

  if (error) {
    if (isMissingBlogTablesError(error.message) && BLOGS_LOCAL_FALLBACK_ENABLED) {
      try {
        await removeLocalBlogPost({ postId, authorId: user.id });
        return res.status(200).json({ ok: true, local: true });
      } catch (localError) {
        const message = localError instanceof Error ? localError.message : 'Local blog store failed.';
        const status = message === 'Post not found.' ? 404 : message === 'Forbidden' ? 403 : 500;
        return res.status(status).json({ error: message });
      }
    }

    const message = normalizeBlogSetupError(error.message);
    const status = isMissingBlogTablesError(error.message) ? 503 : 400;
    return res.status(status).json({ error: message });
  }

  return res.status(200).json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/blogs/comments — add a comment (or reply)
// ---------------------------------------------------------------------------
router.post('/api/blogs/comments', authRequired, async (req, res) => {
  const user = req.user;

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { data: profile } = await req.supabase
    .from('users')
    .select('id')
    .eq('id', user.id)
    .single();

  if (!profile) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : null;
  if (!payload) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const postId = payload.post_id?.trim();
  const body = payload.body?.trim();
  const parentCommentId = payload.parent_comment_id?.trim();

  if (!postId) {
    return res.status(400).json({ error: 'Missing post_id.' });
  }

  if (!body) {
    return res.status(400).json({ error: 'Comment body is required.' });
  }

  const admin = getAdmin();
  const { data: post, error: postError } = await admin
    .from('blog_posts')
    .select('id')
    .eq('id', postId)
    .limit(1);

  if (postError) {
    if (isMissingBlogTablesError(postError.message) && BLOGS_LOCAL_FALLBACK_ENABLED) {
      try {
        await addLocalBlogComment({ postId, authorId: user.id, body, parentCommentId });
        return res.status(200).json({ ok: true, local: true });
      } catch (localError) {
        const message = localError instanceof Error ? localError.message : 'Local blog store failed.';
        const status = message === 'Post not found.' || message === 'Parent comment not found.' ? 404 : 500;
        return res.status(status).json({ error: message });
      }
    }

    const message = normalizeBlogSetupError(postError.message);
    const status = isMissingBlogTablesError(postError.message) ? 503 : 400;
    return res.status(status).json({ error: message });
  }

  if (!post || post.length === 0) {
    return res.status(404).json({ error: 'Post not found.' });
  }

  if (parentCommentId) {
    const { data: parentRows, error: parentError } = await admin
      .from('blog_comments')
      .select('id, post_id')
      .eq('id', parentCommentId)
      .limit(1);

    if (parentError) {
      const message = normalizeBlogSetupError(parentError.message);
      const status = isMissingBlogTablesError(parentError.message) ? 503 : 400;
      return res.status(status).json({ error: message });
    }

    if (!parentRows || parentRows.length === 0 || parentRows[0].post_id !== postId) {
      return res.status(404).json({ error: 'Parent comment not found.' });
    }
  }

  const { data: insertedComment, error } = await admin
    .from('blog_comments')
    .insert({
      post_id: postId,
      author_id: user.id,
      body,
      parent_comment_id: parentCommentId ?? null,
    })
    .select('id, post_id, body, created_at, author_id, parent_comment_id')
    .single();

  if (error) {
    if (isMissingBlogTablesError(error.message) && BLOGS_LOCAL_FALLBACK_ENABLED) {
      try {
        await addLocalBlogComment({ postId, authorId: user.id, body, parentCommentId });
        return res.status(200).json({ ok: true, local: true });
      } catch (localError) {
        const message = localError instanceof Error ? localError.message : 'Local blog store failed.';
        const status = message === 'Post not found.' || message === 'Parent comment not found.' ? 404 : 500;
        return res.status(status).json({ error: message });
      }
    }

    const message = normalizeBlogSetupError(error.message);
    const status = isMissingBlogTablesError(error.message) ? 503 : 400;
    return res.status(status).json({ error: message });
  }

  if (insertedComment) {
    const { data: authorProfile } = await admin
      .from('users')
      .select('id, name, role, dept, year')
      .eq('id', user.id)
      .single();

    return res.status(200).json({
      ok: true,
      comment: {
        id: insertedComment.id,
        body: insertedComment.body,
        createdAt: insertedComment.created_at,
        author: authorProfile ? { id: authorProfile.id, name: authorProfile.name, role: authorProfile.role, dept: authorProfile.dept, year: authorProfile.year } : null,
        parentId: insertedComment.parent_comment_id || null,
      },
    });
  }

  return res.status(200).json({ ok: true });
});

// ---------------------------------------------------------------------------
// DELETE /api/blogs/comments — delete own comment (admins can delete any)
// ---------------------------------------------------------------------------
router.delete('/api/blogs/comments', authRequired, async (req, res) => {
  const user = req.user;

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : null;
  if (!payload) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const commentId = payload.comment_id?.trim();
  if (!commentId) {
    return res.status(400).json({ error: 'Missing comment_id.' });
  }

  const { data: profile } = await req.supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single();
  const isModerator = profile?.role === 'admin';

  const admin = getAdmin();
  const { data: commentRows, error: commentError } = await admin
    .from('blog_comments')
    .select('id, author_id')
    .eq('id', commentId)
    .limit(1);

  if (commentError) {
    if (isMissingBlogTablesError(commentError.message) && BLOGS_LOCAL_FALLBACK_ENABLED) {
      try {
        await removeLocalBlogComment({ commentId, authorId: user.id });
        return res.status(200).json({ ok: true, local: true });
      } catch (localError) {
        const message = localError instanceof Error ? localError.message : 'Local blog store failed.';
        const status = message === 'Comment not found.' ? 404 : message === 'Forbidden' ? 403 : 500;
        return res.status(status).json({ error: message });
      }
    }

    const message = normalizeBlogSetupError(commentError.message);
    const status = isMissingBlogTablesError(commentError.message) ? 503 : 400;
    return res.status(status).json({ error: message });
  }

  if (!commentRows || commentRows.length === 0) {
    return res.status(404).json({ error: 'Comment not found.' });
  }

  if (commentRows[0].author_id !== user.id && !isModerator) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Replies cascade-delete with their parent.
  const { error } = isModerator && commentRows[0].author_id !== user.id
    ? await admin.from('blog_comments').delete().eq('id', commentId)
    : await admin.from('blog_comments').delete().eq('id', commentId).eq('author_id', user.id);

  if (error) {
    if (isMissingBlogTablesError(error.message) && BLOGS_LOCAL_FALLBACK_ENABLED) {
      try {
        await removeLocalBlogComment({ commentId, authorId: user.id });
        return res.status(200).json({ ok: true, local: true });
      } catch (localError) {
        const message = localError instanceof Error ? localError.message : 'Local blog store failed.';
        const status = message === 'Comment not found.' ? 404 : message === 'Forbidden' ? 403 : 500;
        return res.status(status).json({ error: message });
      }
    }

    const message = normalizeBlogSetupError(error.message);
    const status = isMissingBlogTablesError(error.message) ? 503 : 400;
    return res.status(status).json({ error: message });
  }

  return res.status(200).json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/blogs/likes — toggle like on a post
// ---------------------------------------------------------------------------
router.post('/api/blogs/likes', authRequired, async (req, res) => {
  const user = req.user;

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { data: profile } = await req.supabase
    .from('users')
    .select('id')
    .eq('id', user.id)
    .single();

  if (!profile) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : null;
  if (!payload) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const postId = payload.post_id?.trim();
  if (!postId) {
    return res.status(400).json({ error: 'Missing post_id.' });
  }

  const admin = getAdmin();
  const { data: existing, error: existingError } = await admin
    .from('blog_post_likes')
    .select('id')
    .eq('post_id', postId)
    .eq('user_id', user.id)
    .limit(1);

  if (existingError) {
    if (isMissingBlogTablesError(existingError.message) && BLOGS_LOCAL_FALLBACK_ENABLED) {
      try {
        const result = await toggleLocalBlogLike({ postId, userId: user.id });
        return res.status(200).json({ ok: true, liked: result.liked, local: true });
      } catch (localError) {
        const message = localError instanceof Error ? localError.message : 'Local blog store failed.';
        return res.status(500).json({ error: message });
      }
    }

    const message = normalizeBlogSetupError(existingError.message);
    const status = isMissingBlogTablesError(existingError.message) ? 503 : 400;
    return res.status(status).json({ error: message });
  }

  if (existing && existing.length > 0) {
    const { error } = await admin
      .from('blog_post_likes')
      .delete()
      .eq('id', existing[0].id)
      .eq('user_id', user.id);

    if (error) {
      if (isMissingBlogTablesError(error.message) && BLOGS_LOCAL_FALLBACK_ENABLED) {
        try {
          const result = await toggleLocalBlogLike({ postId, userId: user.id });
          return res.status(200).json({ ok: true, liked: result.liked, local: true });
        } catch (localError) {
          const message = localError instanceof Error ? localError.message : 'Local blog store failed.';
          return res.status(500).json({ error: message });
        }
      }

      const message = normalizeBlogSetupError(error.message);
      const status = isMissingBlogTablesError(error.message) ? 503 : 400;
      return res.status(status).json({ error: message });
    }

    return res.status(200).json({ ok: true, liked: false });
  }

  const { error } = await admin
    .from('blog_post_likes')
    .insert({
      post_id: postId,
      user_id: user.id,
    });

  if (error) {
    if (isMissingBlogTablesError(error.message) && BLOGS_LOCAL_FALLBACK_ENABLED) {
      try {
        const result = await toggleLocalBlogLike({ postId, userId: user.id });
        return res.status(200).json({ ok: true, liked: result.liked, local: true });
      } catch (localError) {
        const message = localError instanceof Error ? localError.message : 'Local blog store failed.';
        return res.status(500).json({ error: message });
      }
    }

    const message = normalizeBlogSetupError(error.message);
    const status = isMissingBlogTablesError(error.message) ? 503 : 400;
    return res.status(status).json({ error: message });
  }

  return res.status(200).json({ ok: true, liked: true });
});

// ---------------------------------------------------------------------------
// POST /api/blogs/images — upload a blog image (multipart/form-data)
// ---------------------------------------------------------------------------
const BUCKET = 'blog-images';
const MAX_SIZE_MB = 10;

router.post('/api/blogs/images', authRequired, upload.single('file'), async (req, res) => {
  const user = req.user;

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const file = req.file || null;
  if (!file) {
    return res.status(400).json({ error: 'No file provided.' });
  }

  // Validate type
  const accepted = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  if (!accepted.includes(file.mimetype)) {
    return res.status(400).json({ error: 'Only PNG, JPG, WEBP, GIF are accepted.' });
  }

  // Validate size
  const sizeMB = file.size / 1024 / 1024;
  if (sizeMB > MAX_SIZE_MB) {
    return res.status(400).json({ error: `File exceeds ${MAX_SIZE_MB}MB limit.` });
  }

  const ext = (file.originalname.split('.').pop() || 'jpg');
  const path = `${user.id}/${randomUUID()}.${ext}`;
  const buffer = file.buffer;

  const { error } = await req.supabase.storage
    .from(BUCKET)
    .upload(path, buffer, {
      contentType: file.mimetype,
      cacheControl: '3600',
      upsert: false,
    });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const { data: publicData } = req.supabase.storage.from(BUCKET).getPublicUrl(path);
  return res.status(200).json({ url: publicData.publicUrl });
});

module.exports = router;
