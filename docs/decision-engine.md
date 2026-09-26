# Educational decision engine

`@pi-student/decision` owns the implementation-agnostic contract for bounded choice, yes/no probability, and ordinal score decisions. It validates inputs and outputs, represents confidence, measures latency, and abstains when a provider fails or lacks sufficient confidence. `boundedStudentContext` clips and redacts student text before it reaches a candidate implementation. Allowed purposes are `student-intent`, `context-sufficiency`, and `missing-context`; security, policy, permissions, assessment restrictions, and budgets remain deterministic elsewhere.

`DeterministicDecisionEngine` in `@pi-student/education` is the production implementation. The runtime depends on the `EducationalDecisionEngine` interface, which extends the generic primitives with a rich intent route. The deterministic implementation delegates that route to the existing `routeIntent` logic, preserving scores, ambiguity, and continuation behavior exactly. Another classifier can implement the same interface without changing the runtime consumer. The question loop accepts the base `DecisionEngine` interface, but the deterministic implementation abstains on context sufficiency when the bounded request alone cannot establish it. The existing question-round rules then decide whether to ask. There is no model initialization or download path in the application.

## Evaluate a candidate

After `npm run build`, run:

```sh
npx tsx scripts/evaluate-decision.ts --output /tmp/decision-evaluation.json
```

This evaluates the production deterministic implementation against the labeled fixture set. A future candidate module can export `createDecisionEngine(): DecisionEngine | Promise<DecisionEngine>` and be evaluated with `--candidate ./path/to/candidate.ts`. The runner compares the candidate's raw prediction, accepted decision, and abstention fallback with the existing router and question loop. It records confidence and latency without writing raw prompts to the report.

The fixture set currently has 20 labeled and four ambiguous intent requests, plus 36 context-sufficiency requests. The context labels mean whether the assistant can take a useful next step from the available request and project metadata; they are not instructions to change question behavior. In the [current evaluation](./decision-evaluation.json), the question loop matches 17/36 labels: it flags all 17 incomplete requests for questions, but also asks on all 19 complete requests. Those include detailed debugging, implementation, explanation, tutoring, and review requests. This is the main improvement opportunity. Use the cases to design narrow deterministic checks, validate them on separate requests, and preserve the ability to abstain when needed.

Historical Laya measurements are in [the archived experiment](./experiments/laya-decision.md).
