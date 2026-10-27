#!/bin/sh
# ONCF-LOCAL-PILOT-01 · First-start initialisation of the pilot's auth database (GoTrue only).
# Creates the login GoTrue migrates and runs as, owning the `auth` schema (the layout the GoTrue
# repository uses for its own development database). Runs once, on an empty volume.
set -eu
psql -v ON_ERROR_STOP=1 -v pw="$PILOT_AUTH_ADMIN_PASSWORD" --username postgres --dbname postgres <<'SQL'
CREATE ROLE supabase_auth_admin NOINHERIT CREATEROLE LOGIN NOREPLICATION PASSWORD :'pw';
CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
GRANT CREATE ON DATABASE postgres TO supabase_auth_admin;
ALTER ROLE supabase_auth_admin SET search_path = 'auth';
SQL
