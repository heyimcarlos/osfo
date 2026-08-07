import {
  to = google_project.environment["foundation"]
  id = var.project_ids.foundation
}

import {
  for_each = var.state_bucket_names

  to = google_storage_bucket.state[each.key]
  id = each.value
}
