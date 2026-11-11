#!/usr/bin/env bash
# Create or delete an Aurora PostgreSQL cluster with express configuration.
#
# AWS free-plan projects may only create Aurora clusters this way (FreeTierRestrictionError
# otherwise), and the Terraform AWS provider has no argument for it yet, so Terraform runs this
# script from a terraform_data resource. Express clusters have no VPC: they are reached through
# Aurora's internet access gateway with IAM authentication only.
#
#   express_cluster.sh create <id> <region> <user> <min-acu> <max-acu> <pause-seconds> <deletion-protection>
#
# Express clusters cannot create an initial database: the app uses the built-in "postgres"
# database with its tables in its own "orbitdesk" schema.
#   express_cluster.sh delete <id> <region>
set -euo pipefail

action=$1 id=$2 region=$3

exists() {
  aws rds describe-db-clusters --region "$region" --db-cluster-identifier "$id" >/dev/null 2>&1
}

wait_available() {
  for _ in $(seq 1 90); do
    status=$(aws rds describe-db-clusters --region "$region" --db-cluster-identifier "$id" \
      --query 'DBClusters[0].Status' --output text)
    writer=$(aws rds describe-db-instances --region "$region" \
      --filters "Name=db-cluster-id,Values=$id" --query 'DBInstances[0].DBInstanceStatus' --output text)
    echo "cluster $id: $status, writer: $writer"
    [ "$status" = "available" ] && [ "$writer" = "available" ] && return 0
    sleep 20
  done
  echo "timed out waiting for $id" >&2
  return 1
}

case "$action" in
  create)
    user=$4 min=$5 max=$6 pause=$7 protect=$8
    if exists; then
      echo "cluster $id already exists; leaving it as it is"
    else
      protect_flag=$([ "$protect" = "true" ] && echo --deletion-protection || echo --no-deletion-protection)
      aws rds create-db-cluster --region "$region" \
        --db-cluster-identifier "$id" \
        --engine aurora-postgresql \
        --with-express-configuration \
        --master-username "$user" \
        --serverless-v2-scaling-configuration "MinCapacity=$min,MaxCapacity=$max,SecondsUntilAutoPause=$pause" \
        --backup-retention-period 1 \
        --copy-tags-to-snapshot \
        "$protect_flag" \
        --tags Key=Project,Value=orbit-desk Key=ManagedBy,Value=terraform >/dev/null
    fi
    wait_available
    # Not allowed at creation for express clusters, allowed afterwards: PostgreSQL logs to CloudWatch.
    exports=$(aws rds describe-db-clusters --region "$region" --db-cluster-identifier "$id" \
      --query 'DBClusters[0].EnabledCloudwatchLogsExports' --output text)
    if [ "$exports" != "postgresql" ]; then
      aws rds modify-db-cluster --region "$region" --db-cluster-identifier "$id" --apply-immediately \
        --cloudwatch-logs-export-configuration EnableLogTypes=postgresql >/dev/null \
        && echo "enabled PostgreSQL log export" || echo "could not enable log export (continuing)"
      wait_available
    fi
    ;;
  delete)
    if ! exists; then
      echo "cluster $id is already gone"
      exit 0
    fi
    for instance in $(aws rds describe-db-instances --region "$region" \
        --filters "Name=db-cluster-id,Values=$id" --query 'DBInstances[].DBInstanceIdentifier' --output text); do
      aws rds delete-db-instance --region "$region" --db-instance-identifier "$instance" >/dev/null
      aws rds wait db-instance-deleted --region "$region" --db-instance-identifier "$instance"
    done
    aws rds delete-db-cluster --region "$region" --db-cluster-identifier "$id" --skip-final-snapshot >/dev/null
    for _ in $(seq 1 60); do exists || { echo "cluster $id deleted"; exit 0; }; sleep 20; done
    echo "timed out deleting $id" >&2
    exit 1
    ;;
  *)
    echo "unknown action: $action" >&2
    exit 2
    ;;
esac
