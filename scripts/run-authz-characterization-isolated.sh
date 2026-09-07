#!/usr/bin/env bash
set -eu

network=multiwa-authz-test-net
database=multiwa-authz-test-db
redis=multiwa-authz-test-redis
image=${AUTHZ_TEST_IMAGE:?Set AUTHZ_TEST_IMAGE to the candidate API image}
image_id=$(docker image inspect --format '{{.Id}}' "$image")
image_suffix=${image_id#sha256:}
image_suffix=${image_suffix:0:12}
api=multiwa-authz-api-${image_suffix}
database_url=postgresql://multiwa_test:multiwa_test@${database}:5432/multiwa_test

stop_test_services() {
  docker stop "$api" "$redis" "$database" >/dev/null 2>&1 || true
}
trap stop_test_services EXIT

if [ -n "${AUTHZ_EXPECTED_IMAGE_ID:-}" ] && [ "$image_id" != "$AUTHZ_EXPECTED_IMAGE_ID" ]; then
  echo 'Candidate image identity does not match AUTHZ_EXPECTED_IMAGE_ID.' >&2
  exit 1
fi

docker network inspect "$network" >/dev/null 2>&1 || docker network create "$network" >/dev/null
if ! docker container inspect "$database" >/dev/null 2>&1; then
  docker create --name "$database" --network "$network" \
    --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=256m \
    -e POSTGRES_USER=multiwa_test -e POSTGRES_PASSWORD=multiwa_test \
    -e POSTGRES_DB=multiwa_test --health-cmd='pg_isready -U multiwa_test -d multiwa_test' \
    --health-interval=1s --health-timeout=2s --health-retries=30 postgres:16-alpine >/dev/null
fi
if ! docker container inspect "$redis" >/dev/null 2>&1; then
  docker create --name "$redis" --network "$network" \
    --tmpfs /data:rw,noexec,nosuid,size=64m redis:7-alpine >/dev/null
fi
if [ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}{{end}}{{end}}' "$database")" != tmpfs ] ||
   [ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}{{end}}{{end}}' "$redis")" != tmpfs ]; then
  echo 'Authorization test database and Redis must use temporary filesystems.' >&2
  exit 1
fi

docker start "$database" "$redis" >/dev/null
for _attempt in $(seq 1 30); do
  [ "$(docker inspect --format '{{.State.Health.Status}}' "$database")" = healthy ] && break
  sleep 1
done
if [ "$(docker inspect --format '{{.State.Health.Status}}' "$database")" != healthy ]; then
  echo 'Isolated PostgreSQL did not become ready.' >&2
  exit 1
fi

docker run --rm --entrypoint sh --network "$network" -e DATABASE_URL="$database_url" \
  -w /app/packages/database "$image" -lc 'pnpm exec prisma db push --skip-generate' >/dev/null

if ! docker container inspect "$api" >/dev/null 2>&1; then
  docker create --name "$api" --network "$network" \
    --tmpfs /app/apps/api/data:rw,noexec,nosuid,size=16m \
    --tmpfs /app/apps/api/media:rw,noexec,nosuid,size=16m \
    --tmpfs /data/sessions:rw,noexec,nosuid,size=32m \
    -e NODE_ENV=test -e DATABASE_URL="$database_url" -e REDIS_URL="redis://${redis}:6379" \
    -e API_PORT=3333 -e API_HOST=0.0.0.0 \
    -e JWT_SECRET=synthetic-jwt-secret-for-authorization-tests-only \
    -e JWT_REFRESH_SECRET=synthetic-refresh-secret-for-authorization-tests-only \
    -e ENCRYPTION_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    -e DEMO_MODE=false -e SESSIONS_DIR=/data/sessions "$image" >/dev/null
fi
if [ "$(docker inspect --format '{{.Image}}' "$api")" != "$image_id" ]; then
  echo 'Isolated API container does not use the selected candidate image.' >&2
  exit 1
fi
for mount in /app/apps/api/data /app/apps/api/media /data/sessions; do
  type=$(docker inspect --format "{{range .Mounts}}{{if eq .Destination \"$mount\"}}{{.Type}}{{end}}{{end}}" "$api")
  [ "$type" = tmpfs ] || { echo "Isolated API storage is not temporary: $mount" >&2; exit 1; }
done
docker start "$api" >/dev/null

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

echo "Candidate image verified: $image_id"

docker run --rm --entrypoint node --network "$network" \
  -e AUTHZ_CHARACTERIZATION=1 \
  -e AUTHZ_STATIC_FIXTURE=1 \
  -e AUTHZ_TEST_BASE_URL="http://${api}:3333" \
  -e DATABASE_URL="$database_url" \
  -v "$PWD/scripts/authz-characterization.mjs:/app/scripts/authz-characterization.mjs:ro" \
  -w /app "$image" scripts/authz-characterization.mjs
