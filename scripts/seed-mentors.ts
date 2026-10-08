// Run: npx tsx scripts/seed-mentors.ts
import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(import.meta.dirname!, '../.env') })

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const admin = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
})

const MENTORS: Array<Record<string, any>> = [
  // Example mentors removed per request — only real mentors remain in DB:
  //   - Manjunath R (manjunathr@gmail.com)
  //   - Kshamay P Bharadwaj (kshamay@gmail.com)
  // Kept empty so `npm run seed:mentors` does not re-create deleted accounts.
]

async function seed() {
  console.log('Seeding mentor profiles...\n')

  for (const m of MENTORS) {
    const { data: existingProfile } = await admin
      .from('mentor_profiles')
      .select('user_id')
      .eq('user_id', (await admin.from('users').select('id').eq('email', m.email).maybeSingle()).data?.id || '')
      .maybeSingle()

    const { data: existingUser } = await admin
      .from('users')
      .select('id')
      .eq('email', m.email)
      .maybeSingle()

    if (existingProfile) {
      console.log(`  ↻ ${m.name} already has a mentor profile, skipping`)
      continue
    }

    if (existingUser) {
      // User exists but no mentor profile — just create the profile
      const userId = existingUser.id
      const { error: mentorErr } = await admin.from('mentor_profiles').upsert({
        user_id: userId,
        bio: m.bio,
        skills: m.skills,
        technologies: m.technologies,
        experience_years: m.experience_years,
        linkedin_url: m.linkedin_url,
        github_url: m.github_url,
        availability_status: (m as any).availability_status || 'available',
      }, { onConflict: 'user_id' })

      if (mentorErr) {
        console.error(`  ✗ Failed to create mentor profile for ${m.name}:`, mentorErr.message)
      } else {
        console.log(`  ✓ ${m.name} (${m.email}) — mentor profile created`)
      }
      continue
    }

    const { data: authUser, error: authErr } = await admin.auth.admin.createUser({
      email: m.email,
      password: m.password,
      email_confirm: true,
      user_metadata: { name: m.name, role: 'mentor' }
    })

    if (authErr || !authUser?.user) {
      console.error(`  ✗ Failed to create auth user for ${m.email}:`, authErr?.message)
      continue
    }

    const userId = authUser.user.id

    await admin.from('users').upsert({
      id: userId,
      email: m.email,
      name: m.name,
      role: 'mentor',
    }, { onConflict: 'id' })

    const { error: mentorErr } = await admin.from('mentor_profiles').insert({
      user_id: userId,
      bio: m.bio,
      skills: m.skills,
      technologies: m.technologies,
      experience_years: m.experience_years,
      linkedin_url: m.linkedin_url,
      github_url: m.github_url,
      availability_status: (m as any).availability_status || 'available',
    })

    if (mentorErr) {
      console.error(`  ✗ Failed to create mentor profile for ${m.name}:`, mentorErr.message)
      continue
    }

    console.log(`  ✓ ${m.name} (${m.email}) — ${m.skills.join(', ')}`)
  }

  console.log('\nDone!')
}

seed()
