#!/usr/bin/env bash
# Redeploys the v5 set (the referee, both desks, configure, reserves) from the current contracts.
# The previous record is archived first. Needs Base Sepolia to be accepting transactions.
# Usage: ARCHIVE=bell-v5-rc1 REACT_RESERVES=1.5 bash scripts/redeploy-v5.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ARCHIVE="${ARCHIVE:?set ARCHIVE to the archive name, for example bell-v5-rc1}"
RESERVES="${REACT_RESERVES:-1.5}"
export BASE_SEPOLIA_RPC="${BASE_SEPOLIA_RPC:-https://base-sepolia-rpc.publicnode.com}"

npx hardhat compile
cp deployments/bell.json "deployments/${ARCHIVE}.json"
echo '{}' > deployments/bell.json
STAGE=referee REACT_FUND=0.3 npx hardhat run scripts/deploy.js --network lasna
STAGE=desk:baseSepolia npx hardhat run scripts/deploy.js --network baseSepolia
STAGE=desk:unichainSepolia npx hardhat run scripts/deploy.js --network unichainSepolia
STAGE=configure npx hardhat run scripts/deploy.js --network lasna
# The referee's own 0.3 REACT is not counted as reserves. Move it, and add the rest from the signer.
EXTRA=$(python3 -c "print(max(0.0, float('${RESERVES}') - 0.3))") npx hardhat run scripts/top-up-reserves.js --network lasna
echo "Deployed. Next: re-approve traders, then check_rc_source and get_rc_health."
