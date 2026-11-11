# CloudFront in front of the load balancer: HTTPS for viewers with CloudFront's own certificate
# (no domain needed), AWS-managed security headers, and caching for static assets only.
#
# CloudFront reaches the ALB over HTTP because the ALB has no certificate without a custom
# domain. The hop stays on the AWS network, the ALB accepts only CloudFront's address ranges,
# and every request must carry the secret origin header. With a domain, add an ACM certificate
# to the ALB and switch origin_protocol_policy to https-only.

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewerExceptHostHeader"
}

data "aws_cloudfront_response_headers_policy" "security" {
  name = "Managed-SecurityHeadersPolicy"
}

# WAF is a production next step
#trivy:ignore:AVD-AWS-0011
resource "aws_cloudfront_distribution" "this" {
  #checkov:skip=CKV_AWS_68:WAF is a production next step (about $5/month plus requests)
  #checkov:skip=CKV2_AWS_47:See CKV_AWS_68
  #checkov:skip=CKV_AWS_174:The default CloudFront certificate cannot set a minimum TLS version; use ACM with a custom domain
  #checkov:skip=CKV2_AWS_42:No custom domain in the demo
  #checkov:skip=CKV_AWS_374:Public, worldwide audience
  #checkov:skip=CKV_AWS_310:Single origin; the project is limited to one Region
  #checkov:skip=CKV_AWS_305:The origin is an app that serves / itself
  #checkov:skip=CKV_AWS_86:Access logging needs a log bucket; production next step
  enabled         = true
  comment         = var.name
  price_class     = "PriceClass_100" # Europe and North America edges only
  http_version    = "http2and3"
  is_ipv6_enabled = true

  origin {
    origin_id   = "alb"
    domain_name = var.alb_dns_name
    custom_header {
      name  = var.origin_header_name
      value = var.origin_header_value
    }
    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 30
    }
  }

  # API and pages: never cached, every viewer header (except Host) passed through.
  default_cache_behavior {
    target_origin_id           = "alb"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
  }

  # Hashed build assets (JS, CSS, fonts) can be cached at the edge.
  ordered_cache_behavior {
    path_pattern               = "/assets/*"
    target_origin_id           = "alb"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
