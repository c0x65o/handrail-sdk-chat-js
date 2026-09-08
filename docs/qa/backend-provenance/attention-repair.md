# Linked QA attention diagnosis

Observed 2026-09-05 UTC for SDK repair
`db7b4779-b4b9-4705-8d15-ba8ab17d11fe` and Owner Goal
`b628a20e-48c6-4690-aaac-35b3e64a0442`.

The remaining attention belongs to Handrail's QA routing and reconciliation.
The source repair is already present. The campaign still requires canonical
zero-finding revalidation; a successful code worker's live-check report does
not satisfy that gate automatically. No further SDK behavior change is justified
by the inspected evidence.

## Reproduction and evidence

`owner_check_goal_progress` reproduced the attention state. Its exact reason is
`completed_qa_requires_repair_and_zero_finding_revalidation`. The campaign has
one finding, zero unresolved findings, one resolved linked repair, and zero
active approval actions. See the bounded [read-model snapshot](attention-state.json).

`get_goal_completed_work_result` confirms that finding
`7b76bb04-714b-4ba0-bd52-8e908bd92304` links to completed repair
`7b557337-6d00-4e00-bd89-5a09572b224d`. Its worker succeeded, but the tool returns
zero canonical validation-evidence rows for that repair. The historical QA
summary remains inconclusive because it predates the managed backend refresh.

The closeout path dispatched this additional SDK code-repair request despite
the explicit revalidation reason. The current worker has no typed QA launch or
campaign reconciliation tool, and runtime/config operations and QA launches
are separate actions under this request's execution contract.

## Focused verification

- `node --test test/websocket-ephemeral-signals.test.mjs`: 13 passed, zero failed
  or skipped. Used the existing deterministic websocket harness and fake clock;
  this proves ephemeral behavior, not database persistence.
- Independent Node assertions over the existing saved artifacts passed:
  fresh disk imports match the recorded loaded-function fingerprint; browser
  and live evidence share an instance; all 13 events have strictly increasing
  timestamps per owner, matching `occurredAt`, unchanged TTLs, and final
  typing-stop/presence-offline cleanup. This was artifact verification, not
  a new live QA campaign.
- Fresh `handrail_dev_service_status`: chat-lab PID 2040803 remains supervised,
  owns port 4167, and passes health/readiness with HTTP 200.
- Inspected both payload builders in `src/server/websocket-ephemeral-signals.ts`:
  both use the shared per-owner timestamp allocator and derive expiry from it.

No production source changed in this repair, so no additional compile check was
needed. The existing [runtime evidence](runtime.json) records the preceding
repair's successful TypeScript build. Sibling edits and original QA artifacts
were preserved.

## Platform follow-up and residual risk

Filed Handrail self-repair `1af95e2c-0d19-45fd-b488-c7e22d885219`, titled
"Route repaired convergence QA attention to typed revalidation and resume the
Codex-only goal". The tool confirmed it was queued in the Handrail project and
durably linked to the original Owner Goal. The initial attempt to set the
cross-project origin as `related_work_request_id` failed with
`related_work_request_not_found`; retrying without that unsupported relation
succeeded, with explicit origin/campaign/repair lineage in the description.

Acceptance requires routing the missing check through existing typed QA,
linking its result to the original campaign, preserving attention for unresolved
or failed work, and resuming the intended Codex-only decision runner after
settlement. A done code task must not be treated as a clean QA campaign, and
the historical campaign result must not be rewritten to force closeout.

Attention is **not cleared**. The owner can account for the residual risk using
the passing SDK evidence and this linked platform follow-up, but canonical
zero-finding revalidation or supported evidence reconciliation remains pending.
The original goal should wait for that outcome, then retry its blocked decision
through the Owner Goal runner; its successful resume is not verified here.
