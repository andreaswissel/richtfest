ALTER TABLE auth_rate_limit ALTER COLUMN last_request TYPE bigint USING (extract(epoch FROM last_request) * 1000)::bigint;
