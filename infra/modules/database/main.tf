# Aurora PostgreSQL Serverless v2. Scales between min and max ACU and, with a minimum of 0,
# pauses after a quiet period so an idle demo costs only storage. RDS creates and stores the
# master password in Secrets Manager; Terraform never sees it.

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "PostgreSQL from the app tasks only"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "from_app" {
  for_each                     = toset(var.client_security_group_ids)
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from the app"
}

resource "aws_rds_cluster_parameter_group" "this" {
  name   = var.name
  family = "aurora-postgresql${split(".", var.engine_version)[0]}"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_statement"
    value = "ddl" # record every schema change
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "2000" # log queries slower than 2 s
  }
}

# false positive: storage_encrypted = true with the AWS-managed key
#trivy:ignore:AVD-AWS-0079
resource "aws_rds_cluster" "this" {
  #checkov:skip=CKV_AWS_327:Encrypted with the AWS-managed RDS key; CMK optional
  #checkov:skip=CKV2_AWS_8:Automated backups with point-in-time restore; AWS Backup plan is a production next step
  cluster_identifier                  = var.name
  engine                              = "aurora-postgresql"
  engine_mode                         = "provisioned"
  engine_version                      = var.engine_version
  database_name                       = var.database_name
  master_username                     = var.master_username
  manage_master_user_password         = true
  db_subnet_group_name                = aws_db_subnet_group.this.name
  vpc_security_group_ids              = [aws_security_group.db.id]
  db_cluster_parameter_group_name     = aws_rds_cluster_parameter_group.this.name
  storage_encrypted                   = true
  backup_retention_period             = var.backup_retention_days
  copy_tags_to_snapshot               = true
  deletion_protection                 = var.deletion_protection
  skip_final_snapshot                 = !var.final_snapshot
  final_snapshot_identifier           = var.final_snapshot ? "${var.name}-final" : null
  enabled_cloudwatch_logs_exports     = ["postgresql"]
  iam_database_authentication_enabled = true

  serverlessv2_scaling_configuration {
    min_capacity             = var.min_acu
    max_capacity             = var.max_acu
    seconds_until_auto_pause = var.min_acu == 0 ? var.auto_pause_seconds : null
  }
}

resource "aws_rds_cluster_instance" "writer" {
  #checkov:skip=CKV_AWS_118:Enhanced monitoring adds cost; CloudWatch metrics and PostgreSQL logs are on
  #checkov:skip=CKV_AWS_353:Performance Insights adds cost for a demo
  identifier                   = "${var.name}-writer"
  cluster_identifier           = aws_rds_cluster.this.id
  instance_class               = "db.serverless"
  engine                       = aws_rds_cluster.this.engine
  engine_version               = aws_rds_cluster.this.engine_version
  db_subnet_group_name         = aws_db_subnet_group.this.name
  publicly_accessible          = false
  auto_minor_version_upgrade   = true
  performance_insights_enabled = false
}
