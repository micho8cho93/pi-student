-- The institutional-environments migration adds public tables queried by the
-- organization admin Data API. Refresh PostgREST's cached schema after deploy.
notify pgrst, 'reload schema';
