#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER_DIR="$ROOT_DIR/Docker"
ENV_FILE="${EASYDOC_CONTAINER_ENV_FILE:-$DOCKER_DIR/.env.container}"
COMPOSE_FILE="$DOCKER_DIR/docker-compose.yml"
GPU_FILE="$DOCKER_DIR/docker-compose.gpu.yml"

ACTION=build
GPU=0
PULL_MODEL=1
NO_CACHE=0
PUSH_ECR=0
DEPLOY_ECS=0

usage() {
  cat <<'USAGE'
Usage:
  scripts/build-container.sh [--build-only|--up] [--gpu] [--no-cache] [--no-model-pull]
  scripts/build-container.sh --push-ecr [--deploy-ecs] [--gpu] [--no-cache]
  scripts/build-container.sh --deploy-ecs

Options:
  --build-only      Build the local application image (default)
  --up              Build and start the local Compose services
  --push-ecr        Build, tag, and push the application image to Amazon ECR
  --deploy-ecs      Register a new ECS task revision and update the ECS service
  --gpu             Use the local NVIDIA Compose override while building/running
  --no-cache        Build without Docker layer cache
  --no-model-pull   Do not pull OLLAMA_MODEL during local --up
  -h, --help        Show this help
USAGE
}

while (($#)); do
  case "$1" in
    --build-only) ACTION=build ;;
    --up) ACTION=up ;;
    --push-ecr) PUSH_ECR=1 ;;
    --deploy-ecs) DEPLOY_ECS=1 ;;
    --gpu) GPU=1 ;;
    --no-cache) NO_CACHE=1 ;;
    --no-model-pull) PULL_MODEL=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[ERROR] 알 수 없는 옵션: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "$ACTION" == up && ($PUSH_ECR == 1 || $DEPLOY_ECS == 1) ]]; then
  echo "[ERROR] --up은 --push-ecr/--deploy-ecs와 함께 사용할 수 없습니다." >&2
  exit 2
fi

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$DOCKER_DIR/.env.container.example" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
  echo "[ACTION REQUIRED] 생성된 $ENV_FILE 값을 수정하세요."
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[ERROR] $1 명령이 필요합니다." >&2
    exit 1
  }
}

require_vars() {
  local name
  for name in "$@"; do
    [[ -n "${!name:-}" ]] || {
      echo "[ERROR] $ENV_FILE 환경변수 누락: $name" >&2
      exit 1
    }
  done
}

compose=(--env-file "$ENV_FILE" -f "$COMPOSE_FILE")
((GPU)) && compose+=(-f "$GPU_FILE")

build_local_image() {
  require_command docker
  docker compose version >/dev/null 2>&1 || {
    echo "[ERROR] Docker Compose v2가 필요합니다." >&2
    exit 1
  }
  local args=(build --pull)
  ((NO_CACHE)) && args+=(--no-cache)
  docker compose "${compose[@]}" "${args[@]}" app
}

resolve_ecr_image() {
  require_command aws
  require_vars AWS_REGION ECR_REPOSITORY
  local account_id="${AWS_ACCOUNT_ID:-}"
  if [[ -z "$account_id" ]]; then
    account_id="$(aws sts get-caller-identity --query Account --output text)"
  fi
  [[ "$account_id" =~ ^[0-9]{12}$ ]] || {
    echo "[ERROR] AWS 계정 ID를 확인할 수 없습니다: $account_id" >&2
    exit 1
  }
  ECR_REGISTRY="${account_id}.dkr.ecr.${AWS_REGION}.amazonaws.com"
  ECR_IMAGE="${ECR_REGISTRY}/${ECR_REPOSITORY}:${EASYSTATION_TAG:-latest}"
  export ECR_REGISTRY ECR_IMAGE
}

push_ecr_image() {
  resolve_ecr_image
  require_command docker

  if ! aws ecr describe-repositories --region "$AWS_REGION"       --repository-names "$ECR_REPOSITORY" >/dev/null 2>&1; then
    if [[ "${ECR_CREATE_REPOSITORY:-false}" == true ]]; then
      echo "[INFO] ECR 저장소를 생성합니다: $ECR_REPOSITORY"
      aws ecr create-repository --region "$AWS_REGION"         --repository-name "$ECR_REPOSITORY" >/dev/null
    else
      echo "[ERROR] ECR 저장소가 없습니다: $ECR_REPOSITORY" >&2
      echo "[INFO] 저장소를 먼저 만들거나 ECR_CREATE_REPOSITORY=true를 설정하세요." >&2
      exit 1
    fi
  fi

  echo "[INFO] ECR 로그인: $ECR_REGISTRY"
  aws ecr get-login-password --region "$AWS_REGION" |
    docker login --username AWS --password-stdin "$ECR_REGISTRY"

  local local_image="easydocstation:${EASYSTATION_TAG:-latest}"
  docker image inspect "$local_image" >/dev/null
  docker tag "$local_image" "$ECR_IMAGE"
  docker push "$ECR_IMAGE"
  echo "[OK] ECR push 완료: $ECR_IMAGE"
}

deploy_ecs_service() {
  resolve_ecr_image
  require_command node
  require_vars ECS_CLUSTER ECS_SERVICE ECS_CONTAINER_NAME

  local work_dir current_task new_task
  work_dir="$(mktemp -d)"
  trap 'rm -rf "$work_dir"' RETURN

  current_task="$(aws ecs describe-services     --region "$AWS_REGION"     --cluster "$ECS_CLUSTER"     --services "$ECS_SERVICE"     --query 'services[0].taskDefinition'     --output text)"

  if [[ -z "$current_task" || "$current_task" == None ]]; then
    echo "[ERROR] ECS 서비스 또는 Task Definition을 찾을 수 없습니다." >&2
    exit 1
  fi

  aws ecs describe-task-definition     --region "$AWS_REGION"     --task-definition "$current_task"     --query taskDefinition     --output json > "$work_dir/current-task.json"

  node "$DOCKER_DIR/update-ecs-task-definition.mjs"     "$work_dir/current-task.json"     "$work_dir/new-task.json"     "$ECS_CONTAINER_NAME"     "$ECR_IMAGE"

  new_task="$(aws ecs register-task-definition     --region "$AWS_REGION"     --cli-input-json "file://$work_dir/new-task.json"     --query 'taskDefinition.taskDefinitionArn'     --output text)"

  aws ecs update-service     --region "$AWS_REGION"     --cluster "$ECS_CLUSTER"     --service "$ECS_SERVICE"     --task-definition "$new_task" >/dev/null

  echo "[OK] ECS 배포 시작: $new_task"
  if [[ "${ECS_WAIT_FOR_STABLE:-true}" == true ]]; then
    echo "[INFO] ECS 서비스 안정화를 기다립니다."
    aws ecs wait services-stable       --region "$AWS_REGION"       --cluster "$ECS_CLUSTER"       --services "$ECS_SERVICE"
    echo "[OK] ECS 서비스가 안정화되었습니다."
  fi
}

if ((PUSH_ECR)); then
  build_local_image
  push_ecr_image
  ((DEPLOY_ECS)) && deploy_ecs_service
  exit 0
fi

if ((DEPLOY_ECS)); then
  deploy_ecs_service
  exit 0
fi

require_vars EASYSTATION_STORAGE_DIR EASYSTATION_DATA_DIR EASYSTATION_CONFIG_FILE POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB CLIENT_ORIGIN
for name in EASYSTATION_STORAGE_DIR EASYSTATION_DATA_DIR EASYSTATION_CONFIG_FILE; do
  [[ "${!name}" == /* ]] || {
    echo "[ERROR] $name 은 절대 경로여야 합니다." >&2
    exit 1
  }
done

build_local_image
if [[ "$ACTION" == build ]]; then
  echo "[OK] 이미지 빌드 완료: easydocstation:${EASYSTATION_TAG:-latest}"
  exit 0
fi

[[ "$POSTGRES_PASSWORD" != CHANGE_ME_* && "${JWT_SECRET:-}" != CHANGE_ME_* ]] || {
  echo "[ERROR] 기본 비밀번호와 JWT_SECRET을 변경하세요." >&2
  exit 1
}

make_dir() {
  mkdir -p "$1" 2>/dev/null || {
    command -v sudo >/dev/null && sudo mkdir -p "$1"
  }
}
make_dir "$EASYSTATION_DATA_DIR/Database/ObjectFile/FileTrainingData"
make_dir "$EASYSTATION_DATA_DIR/Database/LanceDB"
make_dir "$EASYSTATION_DATA_DIR/Database/RAGTrainingData"
for part in postgres cassandra redis ollama; do
  make_dir "$EASYSTATION_STORAGE_DIR/$part"
done
make_dir "$(dirname "$EASYSTATION_CONFIG_FILE")"

if [[ ! -e "$EASYSTATION_CONFIG_FILE" ]]; then
  cp "$DOCKER_DIR/config.container.json" "$EASYSTATION_CONFIG_FILE" 2>/dev/null ||
    sudo cp "$DOCKER_DIR/config.container.json" "$EASYSTATION_CONFIG_FILE"
  chmod 0600 "$EASYSTATION_CONFIG_FILE" 2>/dev/null ||
    sudo chmod 0600 "$EASYSTATION_CONFIG_FILE"
fi
node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$EASYSTATION_CONFIG_FILE"

docker compose "${compose[@]}" up -d
if ((PULL_MODEL)) && [[ -n "${OLLAMA_MODEL:-}" ]]; then
  docker compose "${compose[@]}" exec -T ollama ollama pull "$OLLAMA_MODEL"
fi
docker compose "${compose[@]}" ps

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${APP_PORT:-3001}/api/health" >/dev/null 2>&1; then
    echo "[OK] EasyDocStation 실행 중"
    exit 0
  fi
  sleep 5
done
echo "[ERROR] health check 실패" >&2
exit 1
