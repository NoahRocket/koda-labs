-- Ensure we have the 'concepts' column in podcast_jobs
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT FROM information_schema.columns 
    WHERE table_name = 'podcast_jobs' AND column_name = 'concepts'
  ) THEN
    ALTER TABLE podcast_jobs ADD COLUMN concepts JSONB;
  END IF;
END $$;

-- Create admin function for podcast jobs
CREATE OR REPLACE FUNCTION admin_get_podcast_job(job_id_param UUID)
RETURNS SETOF podcast_jobs
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM podcast_jobs
  WHERE job_id = job_id_param;
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION admin_get_podcast_job TO authenticated;
GRANT EXECUTE ON FUNCTION admin_get_podcast_job TO anon;
GRANT EXECUTE ON FUNCTION admin_get_podcast_job TO service_role;

-- Create indexes
CREATE INDEX IF NOT EXISTS podcast_jobs_status_idx ON podcast_jobs(status);
CREATE INDEX IF NOT EXISTS podcast_jobs_user_id_idx ON podcast_jobs(user_id);
