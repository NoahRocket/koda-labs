exports.handler = async () => {
  // Lazy-require to avoid top-level import patching
  const { getSupabaseAdmin } = require('./supabaseClient');

  try {
    const supabase = getSupabaseAdmin();

    // List all files in the root of the 'featured-podcasts' bucket
    const { data: files, error } = await supabase.storage
      .from('featured-podcasts')
      .list('', { limit: 100, sortBy: { column: 'name', order: 'asc' } });

    if (error) {
      console.error('[list-featured-podcasts] Error listing files:', error.message);
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to list featured podcasts' }) };
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    if (!supabaseUrl) {
      console.error('[list-featured-podcasts] Missing SUPABASE_URL env var');
      return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfiguration' }) };
    }

    // Helper: title-case from filename
    const toTitle = (name) => {
      const base = name.replace(/\.[^/.]+$/, '') // drop extension
        .replace(/[-_]/g, ' ')
        .trim();
      return base
        .split(' ')
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    };

    const nowIso = new Date().toISOString(); // includes fractional seconds

    const podcasts = (files || [])
      .filter(f => f && typeof f.name === 'string' && f.name.toLowerCase().endsWith('.mp3'))
      .map(f => {
        const name = f.name;
        const nameEncoded = name.split('/').map(encodeURIComponent).join('/');
        return {
          job_id: `featured-${name.replace(/\.[^/.]+$/, '')}`,
          title: toTitle(name),
          created_at: (f.created_at || f.last_modified || nowIso),
          audio_url: `${supabaseUrl}/storage/v1/object/public/featured-podcasts/${nameEncoded}`,
          duration_seconds: 0,
          concepts: [],
          status: 'completed',
          source: 'featured'
        };
      });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ podcasts })
    };
  } catch (e) {
    console.error('[list-featured-podcasts] Unexpected error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Unexpected server error' }) };
  }
};
