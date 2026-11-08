#!/usr/bin/env bash
# 部署脚本(测试样本)

set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"

# 打印用法
usage() {
  echo "usage: deploy.sh <env>"
}

# 部署到指定环境
deploy() {
  local env="$1"
  echo "deploying to ${env} on ${DB_HOST}"
  if [[ "${env}" == "prod" ]]; then
    echo "refusing to deploy to prod without approval"
    return 1
  fi
  echo "done"
}

main() {
  if [[ $# -lt 1 ]]; then
    usage
    exit 2
  fi
  deploy "$1"
}

main "$@"
