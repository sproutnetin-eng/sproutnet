const express = require('express');
const { getAdmin } = require('../supabase');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// All routes here back the vanilla student pages. They replay the
// server-side admin-client queries from the original pages
// (dashboard, teams, team detail, messages, notifications, blogs, submit).

// GET /api/student/overview — profile + enrolled problems (+submission
// status) + team workspaces. Mirrors app/(student)/dashboard/page.tsx.
router.get('/api/student/overview', authRequired, async (req, res, next) => {
  try {
    const admin = getAdmin();
    const userId = req.user.id;

    const { data: profile } = await admin.from('users').select('*').eq('id', userId).single();
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    let enrolledProblems = [];
    let workspaces = [];

    if (profile.role === 'student') {
      const { data: memberRows } = await admin
        .from('team_members')
        .select('team_id, workspace_id, role, teams(id, name, problem_id, problems(title, domain))')
        .eq('user_id', userId)
        .not('workspace_id', 'is', null)
        .order('created_at', { ascending: false });

      if (memberRows && memberRows.length > 0) {
        const wsIds = [...new Set(memberRows.map((r) => r.workspace_id).filter(Boolean))];
        const { data: wsData } = await admin
          .from('workspaces')
          .select('id, name, status, last_activity_at')
          .in('id', wsIds.length > 0 ? wsIds : ['00000000-0000-0000-0000-000000000000'])
          .neq('status', 'disbanded');
        const wsLookup = new Map((wsData || []).map((ws) => [ws.id, ws]));
        const wsMap = new Map();
        for (const row of memberRows) {
          const ws = wsLookup.get(row.workspace_id || '');
          if (ws && !wsMap.has(ws.id)) {
            const team = row.teams;
            wsMap.set(ws.id, {
              id: ws.id,
              name: ws.name || (team && team.name) || 'Workspace',
              status: ws.status,
              team_id: row.team_id,
              team_name: team && team.name,
              problem_title: team && team.problems && team.problems.title,
              problem_domain: team && team.problems && team.problems.domain,
              role: row.role,
              last_activity_at: ws.last_activity_at,
            });
          }
        }
        workspaces = Array.from(wsMap.values());
      }

      const { data: enrollmentRows } = await admin
        .from('enrollments')
        .select('problem_id, created_at')
        .eq('student_id', userId)
        .eq('status', 'active')
        .order('created_at', { ascending: false });

      const problemIds = Array.from(
        new Set((enrollmentRows || []).map((row) => row.problem_id).filter(Boolean))
      );

      if (problemIds.length > 0) {
        const { data: myMemberships } = await admin
          .from('team_members')
          .select('team_id')
          .eq('user_id', userId);
        const myTeamIds = Array.from(new Set((myMemberships || []).map((m) => m.team_id)));
        let teammateUserIds = [userId];
        if (myTeamIds.length > 0) {
          const { data: teammateRows } = await admin
            .from('team_members')
            .select('user_id')
            .in('team_id', myTeamIds);
          teammateUserIds = Array.from(
            new Set([userId, ...((teammateRows || []).map((r) => r.user_id))])
          );
        }

        const teamByProblem = new Map();
        if (myTeamIds.length > 0) {
          const { data: myTeamsRows } = await admin
            .from('teams')
            .select('id, name, problem_id')
            .in('id', myTeamIds);
          for (const t of myTeamsRows || []) {
            if (t.problem_id) teamByProblem.set(t.problem_id, { id: t.id, name: t.name });
          }
        }

        const [{ data: problemRows }, { data: submissionRows }] = await Promise.all([
          admin
            .from('problems')
            .select('id, title, domain, problem_type, deadline, milestones, status')
            .in('id', problemIds),
          admin
            .from('submissions')
            .select('problem_id, student_id, status, score')
            .in('student_id', teammateUserIds)
            .in('problem_id', problemIds),
        ]);

        const order = new Map(problemIds.map((pid, i) => [pid, i]));
        const STATUS_RANK = { approved: 3, pending: 2, rejected: 1, judged: 2, draft: 0 };
        const byProblem = new Map();
        for (const row of submissionRows || []) {
          const current = byProblem.get(row.problem_id);
          const rank = STATUS_RANK[row.status || ''] !== undefined ? STATUS_RANK[row.status] : -1;
          if (!current) {
            byProblem.set(row.problem_id, { status: row.status, score: row.score, hasSubmission: true });
          } else if ((STATUS_RANK[current.status || ''] !== undefined ? STATUS_RANK[current.status] : -1) < rank) {
            byProblem.set(row.problem_id, { status: row.status, score: row.score, hasSubmission: true });
          }
        }

        enrolledProblems = (problemRows || [])
          .map((problem) => ({
            ...problem,
            hasSubmission: byProblem.has(problem.id),
            submissionStatus: (byProblem.get(problem.id) || {}).status || null,
            submissionScore: (byProblem.get(problem.id) || {}).score ?? null,
            teamId: (teamByProblem.get(problem.id) || {}).id || null,
            teamName: (teamByProblem.get(problem.id) || {}).name || null,
          }))
          .sort((a, b) => (order.get(a.id) || 999) - (order.get(b.id) || 999));
      }
    }

    res.json({ profile, enrolledProblems, workspaces });
  } catch (e) {
    next(e);
  }
});

// GET /api/student/teams — open team-enabled problems + my teams.
// Mirrors app/(student)/teams/page.tsx.
router.get('/api/student/teams', authRequired, async (req, res, next) => {
  try {
    const admin = getAdmin();
    const [{ data: problems }, { data: memberRows }] = await Promise.all([
      admin
        .from('problems')
        .select('id, title, domain, team_mode, min_team_size, max_team_size, deadline')
        .in('team_mode', ['team', 'both'])
        .eq('status', 'open'),
      admin
        .from('team_members')
        .select('team_id, role, teams(id, name, problem_id, problems(title))')
        .eq('user_id', req.user.id)
        .not('team_id', 'is', null),
    ]);

    const myTeams = [];
    for (const row of memberRows || []) {
      if (row.teams) {
        myTeams.push({
          team_id: row.team_id,
          team_name: row.teams.name,
          problem_title: (row.teams.problems && row.teams.problems.title) || 'Unknown Problem',
          role: row.role,
        });
      }
    }

    res.json({ problems: problems || [], myTeams });
  } catch (e) {
    next(e);
  }
});

// GET /api/student/teams/:id — full team workspace payload.
// Mirrors app/(student)/teams/[id]/page.tsx (admin-client reads only;
// workspace auto-creation is left to the staff/team Express routes).
router.get('/api/student/teams/:id', authRequired, async (req, res, next) => {
  try {
    const admin = getAdmin();
    const teamId = req.params.id;
    const userId = req.user.id;

    const { data: membership } = await admin
      .from('team_members')
      .select('role')
      .eq('team_id', teamId)
      .eq('user_id', userId)
      .maybeSingle();

    const { data: mentorAssignment } = await admin
      .from('mentor_assignments')
      .select('id')
      .eq('team_id', teamId)
      .eq('mentor_id', userId)
      .maybeSingle();

    const { data: userProfile } = await admin
      .from('users')
      .select('role, is_master')
      .eq('id', userId)
      .single();

    const isAdmin = !!(userProfile && (userProfile.is_master || userProfile.role === 'admin'));
    const isMember = !!membership;
    const isMentor = !!mentorAssignment;
    if (!isMember && !isMentor && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { data: team } = await admin
      .from('teams')
      .select('*, problems(id, title, domain, team_mode, min_team_size, max_team_size, mentor_required, max_mentors_per_team)')
      .eq('id', teamId)
      .single();
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const { data: members } = await admin
      .from('team_members')
      .select('id, role, joined_at, user_id, users(id, name, email, profile_slug)')
      .eq('team_id', teamId);

    const { data: assignedMentorRows } = await admin
      .from('mentor_assignments')
      .select('assigned_at, mentor_id, users:mentor_id(id, name, email)')
      .eq('team_id', teamId);

    // mentor_profiles has no FK to mentor_assignments, so join it manually.
    let assignedMentors = assignedMentorRows || [];
    {
      const mIds = [...new Set(assignedMentors.map((a) => a.mentor_id).filter(Boolean))];
      if (mIds.length) {
        const { data: profs } = await admin
          .from('mentor_profiles')
          .select('*')
          .in('user_id', mIds);
        const byUser = new Map((profs || []).map((p) => [p.user_id, p]));
        assignedMentors = assignedMentors.map((a) => ({
          ...a,
          mentor_profiles: byUser.get(a.mentor_id) || null,
        }));
      } else {
        assignedMentors = assignedMentors.map((a) => ({ ...a, mentor_profiles: null }));
      }
    }

    const { data: workspace } = await admin
      .from('workspaces')
      .select('*')
      .eq('team_id', teamId)
      .maybeSingle();

    let channelId = null;
    if (workspace) {
      const { data: channel } = await admin
        .from('conversations')
        .select('id')
        .eq('workspace_id', workspace.id)
        .eq('type', 'channel')
        .maybeSingle();
      channelId = (channel && channel.id) || null;
    }

    const { data: mentorsList } = await admin
      .from('mentor_profiles')
      .select('user_id, bio, skills, technologies, availability_status, max_active_teams, users(id, name, email)')
      .eq('availability_status', 'available');

    let activityLogs = [];
    if (workspace) {
      const { data: logs } = await admin
        .from('activity_logs')
        .select('id, action_type, description, created_at, actor_id, users:actor_id(name)')
        .eq('workspace_id', workspace.id)
        .order('created_at', { ascending: false })
        .limit(10);
      activityLogs = logs || [];
    }

    res.json({
      team,
      currentUserId: userId,
      isLeader: membership && membership.role === 'leader',
      isMentor,
      isAdmin,
      members: members || [],
      assignedMentors: assignedMentors || [],
      availableMentors: mentorsList || [],
      workspace: workspace || null,
      channelId,
      activityLogs,
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/student/conversations — conversations the user is a member of.
// Mirrors app/(student)/messages/page.tsx.
router.get('/api/student/conversations', authRequired, async (req, res, next) => {
  try {
    const admin = getAdmin();
    const { data: memberRows } = await admin
      .from('conversation_members')
      .select('conversation_id, conversations(*, workspaces(team_id, teams(name)))')
      .eq('user_id', req.user.id);

    const conversations = (memberRows || []).map((m) => ({
      id: m.conversation_id,
      type: (m.conversations && m.conversations.type) || null,
      name:
        (m.conversations && m.conversations.name) ||
        (m.conversations && m.conversations.workspaces && m.conversations.workspaces.teams && m.conversations.workspaces.teams.name) ||
        'General Channel',
      teamName:
        (m.conversations && m.conversations.workspaces && m.conversations.workspaces.teams && m.conversations.workspaces.teams.name) ||
        'Workspace',
    }));

    res.json({ conversations, currentUserId: req.user.id });
  } catch (e) {
    next(e);
  }
});

// GET /api/student/notifications — list + mark unread as read.
// Mirrors app/(student)/notifications/page.tsx.
router.get('/api/student/notifications', authRequired, async (req, res, next) => {
  try {
    const admin = getAdmin();
    const { data: notifications } = await admin
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    await admin
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', req.user.id)
      .eq('is_read', false);

    res.json({ notifications: notifications || [] });
  } catch (e) {
    next(e);
  }
});

// GET /api/student/posts — current user's blog posts with counts.
// Mirrors the manage query in app/(student)/blogs/manage/page.tsx.
router.get('/api/student/posts', authRequired, async (req, res, next) => {
  try {
    const admin = getAdmin();
    const userId = req.user.id;

    const { data: profile } = await admin
      .from('users')
      .select('id, name, role, dept, year')
      .eq('id', userId)
      .single();

    const { data: postRows, error: postsError } = await admin
      .from('blog_posts')
      .select('id, title, body, post_type, cover_image, excerpt, created_at, author_id')
      .eq('author_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (postsError) return res.status(400).json({ error: postsError.message });

    const posts = postRows || [];
    const postIds = posts.map((p) => p.id);
    let comments = [];
    let likes = [];
    if (postIds.length > 0) {
      const [commentsResult, likesResult] = await Promise.all([
        admin
          .from('blog_comments')
          .select('id, post_id, created_at, author_id')
          .in('post_id', postIds)
          .order('created_at', { ascending: true }),
        admin
          .from('blog_post_likes')
          .select('post_id, user_id')
          .in('post_id', postIds),
      ]);
      comments = commentsResult.data || [];
      likes = likesResult.data || [];
    }

    const commentCounts = new Map();
    const likeCounts = new Map();
    for (const c of comments) commentCounts.set(c.post_id, (commentCounts.get(c.post_id) || 0) + 1);
    for (const l of likes) likeCounts.set(l.post_id, (likeCounts.get(l.post_id) || 0) + 1);
    const likedByViewer = new Set(likes.filter((l) => l.user_id === userId).map((l) => l.post_id));

    const myPosts = posts.map((post) => ({
      id: post.id,
      title: post.title,
      body: post.body || '',
      postType: post.post_type === 'question' ? 'question' : 'knowledge',
      createdAt: post.created_at,
      author: profile,
      likesCount: likeCounts.get(post.id) || 0,
      commentsCount: commentCounts.get(post.id) || 0,
      likedByViewer: likedByViewer.has(post.id),
      comments: [],
      cover_image: post.cover_image || null,
      excerpt: post.excerpt || null,
    }));

    res.json({ viewer: profile, posts: myPosts });
  } catch (e) {
    next(e);
  }
});

// GET /api/student/submit-context?problem_id= — problem + profile +
// enrollment check + existing submission for the submit workspace.
// Mirrors the load logic in app/(student)/problems/[id]/submit/page.tsx.
router.get('/api/student/submit-context', authRequired, async (req, res, next) => {
  try {
    const admin = getAdmin();
    const problemId = req.query.problem_id;
    if (!problemId) return res.status(400).json({ error: 'problem_id is required' });

    const { data: profile } = await admin
      .from('users')
      .select('id, name, dept, year, role')
      .eq('id', req.user.id)
      .single();
    if (!profile || profile.role !== 'student') {
      return res.status(403).json({ error: 'Students only' });
    }

    const { data: enrollment } = await admin
      .from('enrollments')
      .select('id')
      .eq('problem_id', problemId)
      .eq('student_id', req.user.id)
      .eq('status', 'active')
      .maybeSingle();
    if (!enrollment) return res.status(403).json({ error: 'Not enrolled in this problem' });

    const { data: problem } = await admin
      .from('problems')
      .select('id, title, domain, deadline, team_mode')
      .eq('id', problemId)
      .single();

    const { data: submissions } = await admin
      .from('submissions')
      .select('*')
      .eq('problem_id', problemId)
      .eq('student_id', req.user.id)
      .limit(1);

    res.json({ problem: problem || null, profile, submission: (submissions || [])[0] || null });
  } catch (e) {
    next(e);
  }
});

// GET /api/student/final-context?problem_id= — problem + profile +
// approved submission for the final-upload stage.
// Mirrors the load logic in app/(student)/problems/[id]/final-upload/page.tsx.
router.get('/api/student/final-context', authRequired, async (req, res, next) => {
  try {
    const admin = getAdmin();
    const problemId = req.query.problem_id;
    if (!problemId) return res.status(400).json({ error: 'problem_id is required' });

    const { data: profile } = await admin
      .from('users')
      .select('id, name, dept, year, role')
      .eq('id', req.user.id)
      .single();
    if (!profile || profile.role !== 'student') {
      return res.status(403).json({ error: 'Students only' });
    }

    const { data: submissions } = await admin
      .from('submissions')
      .select('id, status, score, judge_feedback, participant_type, final_deliverables')
      .eq('problem_id', problemId)
      .eq('student_id', req.user.id)
      .limit(1);

    const row = (submissions || [])[0];
    if (!row || row.status !== 'approved') {
      return res.status(403).json({ error: 'Submission is not approved yet' });
    }

    const { data: problem } = await admin
      .from('problems')
      .select('id, title, domain, team_mode')
      .eq('id', problemId)
      .single();

    res.json({ problem: problem || null, profile, submission: row });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
