# ADR 0001: No NAT gateway; app tasks use public IPs for outbound traffic

**Status:** accepted, 2026-11-12

## Context

The app calls public data feeds (USGS, GDACS, NASA EONET, NOAA, CelesTrak) over the internet.
Tasks in private subnets would need a NAT gateway: about $35 a month per gateway plus $0.05 per
GB processed in eu-north-1, and two of them for zone redundancy. For a demo stack that runs for a
few hours at a time, that is most of the bill.

## Decision

Run the Fargate tasks in public subnets with `assign_public_ip = true`. Their security group
accepts inbound traffic only from the load balancer's security group, on the app port. The load
balancer accepts traffic only from CloudFront's origin-facing prefix list, and only requests with a
secret origin header are forwarded. The database lives in isolated subnets with no internet route
and accepts connections only from the app's security group.

## Consequences

- A public IPv4 address per task ($0.005 an hour) instead of a NAT gateway.
- Outbound traffic leaves from the task's own address, so it cannot be pinned to one fixed IP for a
  partner's allow-list. If that is needed, add a NAT gateway (or one per zone) and move the tasks to
  private subnets; only the network module and the service's subnet list change.
- Checkov's CKV_AWS_333 ("ECS services should not get public IPs") is skipped with a pointer here.
