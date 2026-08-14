import { NextResponse } from 'next/server';
import { supabase } from '@/lib/db/client';

// GET /api/leads
//
// Returns ALL leads, unfiltered — the dashboard groups them by stage
// client-side. If lead volume grows large later, this route would need
// pagination or a `?stage=` filter, but that's out of scope for now.

export async function GET() {
  const { data, error } = await supabase
    .from('leads')
    .select('id, name, email, channel, stage, message, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Failed to fetch leads:', error);
    return NextResponse.json(
      { error: 'Failed to load leads' },
      { status: 500 }
    );
  }

  return NextResponse.json({ leads: data });
}
