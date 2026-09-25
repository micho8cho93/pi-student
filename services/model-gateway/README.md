# Institution model gateway

Run this service on a trusted host with Node.js 23.6 or newer, after applying the organization governance migration. It holds provider credentials and is required for managed student projects. Standalone Pi Student continues to use its existing model path.

Set these server-only environment variables:

- `PI_STUDENT_SUPABASE_URL`: Supabase project URL.
- `PI_STUDENT_SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key. Never place it in the student client.
- `PI_STUDENT_GATEWAY_PROVIDERS`: JSON object keyed by provider name, for example `{"openai":{"baseUrl":"https://api.openai.com/v1","apiKey":"..."}}`. Endpoints must use HTTPS, except localhost for development.
- `PI_STUDENT_GATEWAY_HOST` and `PI_STUDENT_GATEWAY_PORT`: bind address and port; defaults are `127.0.0.1:4176`.

Build with `npm run build --workspace=@pi-student/model-gateway`, then run `node services/model-gateway/dist/cli.js`. Set `PI_STUDENT_MODEL_GATEWAY_URL` in the managed student client to the externally reachable HTTPS URL. The client sends only its Supabase access token and approved profile ID. `GET /healthz` checks that the process is listening.

The gateway supports text-only OpenAI-compatible chat completions. It reserves a maximum of 32,000 input tokens and the requested output limit, capped at 4,096 tokens, then settles provider-reported usage before returning a response. Short editor completions request 160 output tokens. An upstream or settlement failure leaves a reservation held; review those rows operationally before adjusting budgets or reclaiming capacity. A missing price blocks requests under a cost budget. The gateway should be protected by normal host and network controls in addition to its per-request authorization.
