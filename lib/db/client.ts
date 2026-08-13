import { createClient } from '@supabase/supabase-js';

// SERVER-ONLY. This client is initialized with the Supabase service role
// key, which bypasses RLS entirely. It must only ever be imported from
// server-side code (API routes) — never from client components — or the
// service role key will end up in the browser bundle.

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
