variable "proof_token" {
  description = "Non-secret marker used to prove the development Terraform lifecycle."
  type        = string
}

resource "terraform_data" "disposable_proof" {
  input = {
    environment = "development"
    token       = var.proof_token
  }
}

output "disposable_proof_id" {
  description = "Identifier for the disposable lifecycle proof."
  value       = terraform_data.disposable_proof.id
}
