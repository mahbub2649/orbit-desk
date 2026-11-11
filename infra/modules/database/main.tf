# Aurora PostgreSQL Serverless v2, created with express configuration.
#
# On AWS free-plan projects, express configuration is the only way to create an Aurora cluster.
# Such a cluster lives outside your VPC and is reached through Aurora's internet access gateway
# (TLS, AWS Shield) with IAM authentication only: there is no database password anywhere. The app
# signs a 15-minute token with its task role for each new connection.
#
# The Terraform AWS provider has no argument for express configuration yet, so a terraform_data
# resource runs express_cluster.sh on create and destroy, and a data source reads the result.
# On an account without this restriction, use aws_rds_cluster in a VPC with
# manage_master_user_password instead (see git history of this module).

resource "terraform_data" "cluster" {
  input = {
    id       = var.name
    region   = var.region
    username = var.master_username
    min_acu  = var.min_acu
    max_acu  = var.max_acu
    pause    = var.auto_pause_seconds
    protect  = var.deletion_protection
    script   = "${path.module}/express_cluster.sh"
  }

  provisioner "local-exec" {
    command = join(" ", [
      self.input.script, "create", self.input.id, self.input.region, self.input.username,
      self.input.min_acu, self.input.max_acu, self.input.pause, self.input.protect,
    ])
  }

  provisioner "local-exec" {
    when    = destroy
    command = "${self.input.script} delete ${self.input.id} ${self.input.region}"
  }
}

data "aws_rds_cluster" "this" {
  cluster_identifier = terraform_data.cluster.output.id
  depends_on         = [terraform_data.cluster]
}
