#!/usr/bin/env bash
set -eu

network=multiwa-ack-stage1-net
database=multiwa-ack-stage1-db
redis=multiwa-stage2a-redis
api=multiwa-stage2a-api
image=${AUTHZ_TEST_IMAGE:-multiwa-api:ack-stage1-2d51359}
database_url=postgresql://multiwa_test:multiwa_test@${database}:5432/multiwa_test

stop_test_services() {
  docker stop "$api" "$redis" "$database" >/dev/null 2>&1 || true
}
trap stop_test_services EXIT

docker image inspect "$image" >/dev/null
docker network inspect "$network" >/dev/null
docker start "$database" "$redis" "$api" >/dev/null

ready=0
for _attempt in $(seq 1 30); do
  code=$(docker exec "$api" node -e \
    "fetch('http://127.0.0.1:3333/api/v1/health').then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write('0'))" \
    2>/dev/null || true)
  if [ "$code" = 200 ]; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  echo 'Isolated MultiWA API did not become ready.' >&2
  exit 1
fi

docker exec "$api" node -e \
  "require('fs').mkdirSync('/app/apps/api/media',{recursive:true});require('fs').writeFileSync('/app/apps/api/media/stage2a-synthetic.txt','synthetic authorization fixture')"

docker run --rm --entrypoint node --network "$network" \
  -e AUTHZ_CHARACTERIZATION=1 \
  -e AUTHZ_STATIC_FIXTURE=1 \
  -e AUTHZ_TEST_BASE_URL="http://${api}:3333" \
  -e DATABASE_URL="$database_url" \
  -v "$PWD/scripts/authz-characterization.mjs:/app/scripts/authz-characterization.mjs:ro" \
  -w /app "$image" scripts/authz-characterization.mjs
