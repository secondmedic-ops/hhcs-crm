-- New login type: a service provider's staff (Book My Medicare). Own file: Postgres cannot use a new enum value
-- in the same transaction that adds it, and the next migration's policies use it.
alter type app_role add value if not exists 'provider';
