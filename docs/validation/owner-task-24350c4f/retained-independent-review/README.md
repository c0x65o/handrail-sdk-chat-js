# Retained independent QA evidence

Exact historical output from QA work request 57d62709-f258-4f62-ab23-56b4e1101769, run 530e0cd7-ad95-4528-8570-1178e6144464, delivered for owner task 24350c4f-985e-4762-ac15-445f69009f18. See delivery.json for byte identities and limits. This additive evidence folder does not change the reviewed runtime artifact or overwrite original validation history.

Import procedure: verify delivery.json file sizes and SHA-256, reject archive absolute/traversal/duplicate/link entries, verify all report-sha256.json entries, and inspect the retained REVIEW.md, WORKER_RESULT.json and relevant PNGs. Extract only into the current QA run's private writable validation directory. Register retained captures through handrail_record_qa_runtime_evidence / handrail_persist_qa_artifact with original provenance and fresh_capture=false. Record the current import outcome honestly; preserve original inconclusive status and all live/native/PostgreSQL limitations. Do not recreate compatibility tests for this evidence-delivery check.

For later evidence, save shareable reports/captures in the assigned project's task evidence folder while retaining source-run provenance. A run-private path alone is not a handoff to a subsequent isolated worker. Do not broaden filesystem mounts.
