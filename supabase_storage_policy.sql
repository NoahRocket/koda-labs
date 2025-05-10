-- Create Storage RLS Policies for podcasts bucket

-- Enable RLS on the storage.objects table
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Create policy to allow anyone to read podcast files
CREATE POLICY "Public Read Access for Podcasts" 
ON storage.objects FOR SELECT 
USING (bucket_id = 'podcasts');

-- Create policy to allow authenticated users to upload their own podcasts
CREATE POLICY "Authenticated Users Upload Access"
ON storage.objects FOR INSERT 
TO authenticated
USING (bucket_id = 'podcasts' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Create policy to allow service role to bypass RLS
CREATE POLICY "Service Role Full Access"
ON storage.objects 
USING (auth.role() = 'service_role');

-- Create policy for admin functions to have full access
CREATE POLICY "Admin Function Full Access"
ON storage.objects
USING ((SELECT 1 FROM pg_catalog.pg_proc WHERE proname = 'admin_get_podcast_job'));

-- Update bucket permissions (if needed)
UPDATE storage.buckets 
SET public = true 
WHERE name = 'podcasts';
