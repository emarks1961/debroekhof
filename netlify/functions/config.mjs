// Openbare configuratie voor de browser: Supabase-adres en anon key.
// De anon key is bedoeld om openbaar te zijn; toegang wordt geregeld door
// login + Row Level Security in de database.
export default async () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return Response.json({ fout: 'SUPABASE_URL of SUPABASE_ANON_KEY ontbreekt' }, { status: 500 });
  }
  return Response.json({ supabaseUrl, supabaseAnonKey }, {
    headers: { 'Cache-Control': 'no-store' },
  });
};

export const config = { path: '/api/config' };
