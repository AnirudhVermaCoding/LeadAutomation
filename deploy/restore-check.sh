#!/usr/bin/env bash
# Is a restored database sound?   deploy/restore-check.sh [db]     (exit 1 = no)
#
#  - every tenant table has row-level security ON and a policy,
#  - the app role is not a superuser and cannot bypass RLS,
#  - as the app role with no tenant set you see no tenant data; with a tenant set you see only that tenant's.
# Run by restore.sh, and by CI against a freshly seeded database (deploy/restore-test.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${1:-instantlead_restore}"
read -ra COMPOSE <<< "docker compose ${COMPOSE_FILES:--f docker-compose.yml -f deploy/docker-compose.prod.yml}"
[ -n "${PSQL_CMD:-}" ] || PSQL_CMD="${COMPOSE[*]} exec -T db psql -U instantlead -v ON_ERROR_STOP=1 -At -d $DB"
q() { $PSQL_CMD -c "$1"; }

bad="$(q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace and n.nspname='public'
  where c.relkind='r' and exists (select 1 from information_schema.columns k where k.table_schema='public' and k.table_name=c.relname and k.column_name='tenant_id')
  and (not c.relrowsecurity or not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname))")"
[ "$bad" = "0" ] || { echo "!! $bad tenant tables lost RLS or their policy in the restore" >&2; exit 1; }

role="$(q "select rolsuper::int || rolbypassrls::int from pg_roles where rolname='instantlead_app'")"
[ "$role" = "00" ] || { echo "!! the app role is missing or too powerful ($role)" >&2; exit 1; }

# No tenant context: the app role must see nothing, even though the database has data.
total="$(q "select count(*) from leads")"
none="$(q "begin; set local role instantlead_app; select count(*) from leads; rollback;" | grep -E '^[0-9]+$' | head -1)"
[ "$none" = "0" ] || { echo "!! app role sees $none leads with no tenant set" >&2; exit 1; }

# One tenant at a time: its own count, nothing else.
tenant="$(q "select tenant_id from leads group by tenant_id order by count(*) desc limit 1")"
if [ -n "$tenant" ]; then
  own="$(q "select count(*) from leads where tenant_id='$tenant'")"
  seen="$(q "begin; set local role instantlead_app; select set_config('app.tenant_id','$tenant',true); select count(*) from leads; rollback;" | grep -E '^[0-9]+$' | tail -1)"
  [ "$seen" = "$own" ] || { echo "!! tenant isolation broke: sees $seen of $own" >&2; exit 1; }
fi
echo "ok: RLS intact, app role locked down, $total leads, tenant isolation holds"
