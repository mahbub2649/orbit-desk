# Two public subnets for the load balancer and the app tasks, two isolated subnets for the
# database. There is no NAT gateway (about $35 a month plus traffic): tasks get a public IP for
# their outbound calls to public data feeds, and their security group accepts traffic only from
# the load balancer. See docs/adr/0001-no-nat-gateway.md.

data "aws_availability_zones" "available" {
  #checkov:skip=CKV_AWS_394:The first two zones are chosen once; Terraform shows any change in plan
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

# Default security group with no rules: nothing can use it by accident.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_flow_log" "this" {
  count                = var.flow_log_group_arn == "" ? 0 : 1
  vpc_id               = aws_vpc.this.id
  traffic_type         = "REJECT"
  log_destination_type = "cloud-watch-logs"
  log_destination      = var.flow_log_group_arn
  iam_role_arn         = var.flow_log_role_arn
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.cidr, 8, count.index)
  map_public_ip_on_launch = false # tasks ask for a public IP explicitly; nothing else gets one
  tags                    = { Name = "${var.name}-public-${local.azs[count.index]}" }
}

resource "aws_subnet" "isolated" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.cidr, 8, 10 + count.index)
  tags              = { Name = "${var.name}-isolated-${local.azs[count.index]}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Isolated subnets use a route table with no internet route.
resource "aws_route_table" "isolated" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-isolated" }
}

resource "aws_route_table_association" "isolated" {
  count          = 2
  subnet_id      = aws_subnet.isolated[count.index].id
  route_table_id = aws_route_table.isolated.id
}
