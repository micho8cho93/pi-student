# Archived experiment: Laya for educational decisions

This is a historical experiment. Laya is no longer installed, initialized, or configurable in the Pi Student runtime. The generic decision contract and evaluation runner remain available for future research.

## Tested setup

The experiment used the local English 421M parameter fp32 ONNX export via `@receptron/laya` on Apple silicon with Node 24. The model bundle was about 1.7 GB. Intent and context-sufficiency requests used short, redacted student text and bounded metadata. The model did not handle security or authorization decisions. The experiment used a provisional high-confidence threshold of 0.90 and a medium threshold of 0.70. The thresholds were configurable, but not calibrated for student requests.

## Results

| Decision | Existing deterministic flow | Laya raw result | Accepted Laya result | Fallback flow |
| --- | ---: | ---: | ---: | ---: |
| Intent, 20 labeled requests | 19/20 | 17/20 | 2/2, only 2 of 24 total intent requests accepted | 19/20 |
| Context sufficiency, 8 requests | 4/8 | 3/8 | 0/1 | 4/8 |

Laya classified two tutoring requests as explanation and did not recover the existing router's missed collaborative request. Its only accepted sufficiency prediction was wrong: it judged a detailed debugging request insufficient.

Median decision latency was 657 ms, p95 was 2,248 ms, and the first model load plus inference took 6,263 ms. The small hand-labeled fixture set is insufficient to establish population-level performance, but it provided no reason to put Laya in the application path. Its accuracy, latency, cold start, and install size did not justify the dependency. The ONNX adapter, environment configuration, and runtime hook were removed.

The original row-level [evaluation JSON](./laya-decision-evaluation.json) remains for comparison. It contains predictions and timings, not raw prompts. The expanded generic fixture set now lives in [`packages/decision/test/fixtures.ts`](../../packages/decision/test/fixtures.ts); current evaluations use [`scripts/evaluate-decision.ts`](../../scripts/evaluate-decision.ts).
