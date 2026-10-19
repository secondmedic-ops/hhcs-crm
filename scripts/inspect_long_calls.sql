-- Read-only diagnostic. Contains phone numbers and provider payloads; keep results private.
SELECT id, session_id, direction, status, started_at, ended_at, talk_seconds,
       round(talk_seconds / 3600.0, 2) as talk_hours, customer_number, raw
FROM calls
ORDER BY talk_seconds DESC NULLS LAST
LIMIT 10;

-- Compare stored values with the reporting policy without printing personal data.
SELECT count(*) AS total_calls,
       count(*) FILTER (WHERE talk_seconds > 14400) AS over_four_hours,
       count(*) FILTER (WHERE talk_seconds < 0) AS negative_durations,
       round(avg(talk_seconds) FILTER (WHERE talk_seconds > 0), 2) AS stored_avg_seconds,
       round(avg(talk_seconds) FILTER (
         WHERE status IN ('answered', 'completed') AND talk_seconds BETWEEN 1 AND 14400
       ), 2) AS clean_avg_seconds
FROM calls;
