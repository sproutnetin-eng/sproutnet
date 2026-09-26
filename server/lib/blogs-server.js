'use strict';

const {
  BLOGS_SETUP_REQUIRED_MESSAGE,
  isMissingBlogCommentParentColumnError,
  isMissingBlogTablesError,
  normalizeBlogSetupError,
} = require('./blogs');
const {
  BLOGS_LOCAL_FALLBACK_ENABLED,
  getLocalBlogRows,
} = require('./blogs-local');

function createAdminClient() {
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase admin credentials are not configured');
  return createClient(url, key);
}

function isSupabaseClient(value) {
  return !!value && typeof value === 'object' && typeof value.from === 'function';
}

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

    users = (userRows ?? []);
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
        .filter((user) => Boolean(user));

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
  return buildFeedFromRows({
    admin,
    posts,
    comments,
    likes,
    viewerId,
  });
}

// Accepts an already-created supabase (admin) client as the first parameter:
//   getBlogFeed(admin, viewerId?)
// For backwards compatibility, getBlogFeed(viewerId?) (no client) still works
// by creating an admin client from env vars.
async function getBlogFeed(adminOrViewerId, maybeViewerId) {
  let admin;
  let viewerId;
  if (isSupabaseClient(adminOrViewerId)) {
    admin = adminOrViewerId;
    viewerId = maybeViewerId;
  } else if (adminOrViewerId === undefined) {
    admin = createAdminClient();
    viewerId = maybeViewerId;
  } else {
    admin = createAdminClient();
    viewerId = adminOrViewerId;
  }

  try {
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

        return {
          posts: [],
          error: BLOGS_SETUP_REQUIRED_MESSAGE,
          setupRequired: true,
        };
      }

      return {
        posts: [],
        error: normalizeBlogSetupError(postsError.message),
        setupRequired: false,
      };
    }

    const posts = (postRows ?? []);
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
      commentRows = (initialComments ?? []);
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

    const comments = (commentRows ?? []);
    const likes = (likeRows ?? []);

    return await buildFeedFromRows({
      admin,
      posts,
      comments,
      likes,
      viewerId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network request failed.';
    return {
      posts: [],
      error: normalizeBlogSetupError(message),
      setupRequired: false,
    };
  }
}

module.exports = {
  getBlogFeed,
};
