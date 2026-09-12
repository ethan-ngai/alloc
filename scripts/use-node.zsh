#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
repo_dir=${script_dir:h}
node_version=$(<"$repo_dir/.nvmrc")
nvm_root=${NVM_DIR:-${HOME}/.nvm}

if [[ -s "$nvm_root/nvm.sh" ]]; then
  source "$nvm_root/nvm.sh"
  nvm install "$node_version" >/dev/null
  nvm use --silent "$node_version"
fi

exec "$@"
