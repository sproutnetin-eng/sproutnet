require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { cacheGet } = require('./middleware/cache');

const app = express();
const PORT = process.env.PORT || 3001;
const CLIENT = path.join(__dirname, '..', 'client');

app.use(cors());
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Runtime config for the vanilla frontend (Supabase URL + anon key).
app.get('/assets/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(
    `window.SUPABASE_URL=${JSON.stringify(process.env.NEXT_PUBLIC_SUPABASE_URL || '')};` +
    `window.SUPABASE_ANON_KEY=${JSON.stringify(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '')};`
  );
});

// Clean-URL page routes -> static HTML files.
const pages = {
  '/': 'index.html',
  '/login': 'login.html',
  '/login/student': 'login-student.html',
  '/login/poster': 'login-poster.html',
  '/login/mentor': 'login-mentor.html',
  '/login/admin': 'login-admin.html',
  '/join': 'join.html',
  '/forgot-password': 'forgot-password.html',
  '/problems': 'problems.html',
  '/problems/:id/submit': 'submit.html',
  '/problems/:id/final-upload': 'final-upload.html',
  '/problems/:id': 'problem-detail.html',
  '/solutions': 'solutions.html',
  '/solutions/:id': 'solution-detail.html',
  '/blogs/new': 'blog-new.html',
  '/blogs/manage': 'blog-manage.html',
  '/blogs/:id': 'blog-detail.html',
  '/blogs': 'blogs.html',
  '/how-it-works': 'how-it-works.html',
  '/leaderboard': 'leaderboard.html',
  '/mentors': 'mentors.html',
  '/mentor/dashboard': 'mentor-dashboard.html',
  '/mentor/profile': 'mentor-profile.html',
  '/mentor/connect/:notificationId': 'mentor-connect.html',
  '/profile': 'profile.html',
  '/profile/:slug': 'profile.html',
  '/setup-admin': 'setup-admin.html',
  '/dashboard': 'dashboard.html',
  '/teams': 'teams.html',
  '/teams/:id': 'team-detail.html',
  '/messages': 'messages.html',
  '/notifications': 'notifications.html',
  '/poster/dashboard': 'poster-dashboard.html',
  '/poster/post-problem': 'post-problem.html',
  '/poster/problems': 'poster-problems.html',
  '/poster/problems/:id/edit': 'poster-problem-edit.html',
  '/poster/problems/:id/enrollments': 'poster-enrollments.html',
  '/poster/solutions': 'poster-solutions.html',
  '/admin/analytics': 'admin-analytics.html',
  '/admin/judging': 'admin-judging.html',
  '/admin/problems/:id/edit': 'admin-problem-edit.html',
  '/admin/problems/:id/enrollments': 'admin-enrollments.html',
  '/admin/problems': 'admin-problems.html',
  '/admin/solutions': 'admin-solutions.html',
  '/admin': 'admin.html',
};
for (const [route, file] of Object.entries(pages)) {
  app.get(route, (req, res) => res.sendFile(path.join(CLIENT, file)));
}

app.use('/assets', express.static(path.join(CLIENT, 'assets'), { maxAge: '1h' }));
app.use(express.static(CLIENT, { maxAge: 0 }));

// 60s server-side cache for anonymous-safe public reads (Supabase RTT saver).
app.get([
  '/api/public/stats',
  '/api/public/problems',
  '/api/public/problems/:id',
  '/api/public/leaderboard',
  '/api/public/mentors',
  '/api/public/solutions',
], cacheGet(60));

// API routers. Each file exports an express.Router with full `/api/...` paths.
const routers = [
  './routes/problems',
  './routes/enrollments',
  './routes/submissions',
  './routes/teams',
  './routes/workspaces',
  './routes/mentors',
  './routes/blogs',
  './routes/auth',
  './routes/admin',
  './routes/misc',
  './routes/public-reads',
  './routes/student-reads',
  './routes/staff-reads',
];
for (const r of routers) {
  try {
    app.use(require(r));
    console.log('mounted', r);
  } catch (e) {
    console.warn('skip', r + ':', e.message);
  }
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`SproutNet Node server on http://localhost:${PORT}`));
