const { createClient } = require('@supabase/supabase-js');

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Service-role client for privileged cross-user queries (replaces lib/supabase/admin.ts).
function getAdmin() {
  return createClient(URL, SERVICE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// User-scoped client that carries the caller's JWT (replaces lib/supabase/server.ts).
function getUserClient(token) {
  return createClient(URL, ANON, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function getUserFromToken(token) {
  const supabase = getUserClient(token);
  const { data } = await supabase.auth.getUser();
  return { user: data.user || null, supabase };
}

module.exports = { getAdmin, getUserClient, getUserFromToken };
