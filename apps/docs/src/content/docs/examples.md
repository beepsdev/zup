---
title: Running the Examples
description: How to run the included example scripts and what each one demonstrates.
---

The `examples/` directory contains runnable scripts that demonstrate Zup's capabilities. Each example is a standalone TypeScript file that you can run with Bun.

## Prerequisites

Clone the repository and install dependencies:

```bash
git clone https://github.com/beepsdev/zup.git
cd zup
bun install
```

Some examples require environment variables. Bun loads `.env` files automatically, so you can create a `.env` file in the repository root:

```bash
# Only needed for llm-demo.ts
ANTHROPIC_API_KEY=sk-ant-...
# or
OPENAI_API_KEY=sk-...
```

## demo.ts -- Basic OODA loop

**What it shows:** Creating an agent with the example plugin, running a single OODA loop, and inspecting the results from each phase.

**Run:**

```bash
bun examples/demo.ts
```

**What happens:**

1. Creates an agent with the `examplePlugin`, which registers a mock observer, orienter, decision strategy, and action.
2. Prints the registered capabilities.
3. Runs a single OODA loop.
4. Prints the observations, situation assessment, decision, and action results.

**Expected output:**

```
=== Zup Demo ===

Agent created successfully!

Available capabilities:
- Observers: [ 'example:healthCheck' ]
- Orienters: [ 'example:analyzeHealth' ]
- Decision Strategies: [ 'example:basicResponse' ]
- Actions: [ 'example:restartService' ]

Running OODA loop...

=== OODA Loop Results ===

OBSERVE Phase:
- Collected 1 observations
  - [info] example/health-check: {"status":"ok","responseTime":42}

ORIENT Phase:
- Summary: System is operating normally
- Priority: low
- Confidence: 0.9

DECIDE Phase:
- Action: no-op
- Rationale: System is healthy, no action needed
- Confidence: 0.95
- Risk: low

ACT Phase:
- Executed 0 actions

=== Loop completed in 3ms ===

Total loops executed: 1
```

This example needs no external services or API keys.

## api-demo.ts -- REST API server

**What it shows:** Starting the agent's built-in REST API with authentication, and using curl to interact with it.

**Run:**

```bash
bun examples/api-demo.ts
```

**What happens:**

1. Creates an agent with the example plugin and a Winston logger.
2. Starts the API server on port 3000 with a demo API key.
3. Prints curl commands you can use to interact with the API.
4. Keeps running until you press Ctrl+C.

**Endpoints to try:**

```bash
# Health check (no auth)
curl http://localhost:3000/api/v0/health

# Get agent state
curl http://localhost:3000/api/v0/state \
  -H "Authorization: Bearer demo-key-123"

# Trigger an OODA loop
curl -X POST http://localhost:3000/api/v0/loop/trigger \
  -H "Authorization: Bearer demo-key-123"

# List available actions
curl http://localhost:3000/api/v0/actions \
  -H "Authorization: Bearer demo-key-123"

# Execute an action directly
curl -X POST http://localhost:3000/api/v0/actions/example:restartService \
  -H "Authorization: Bearer demo-key-123" \
  -H "Content-Type: application/json" \
  -d '{"params": {"serviceName": "my-api-service"}}'
```

This example needs no external services or API keys. It does use `winston` for structured logging, which is included in the project dependencies.

## http-monitor-demo.ts -- HTTP monitoring

**What it shows:** The `httpMonitor` plugin watching a live endpoint, detecting failures, and automatically restarting the service.

**Run:**

```bash
bun examples/http-monitor-demo.ts
```

**What happens:**

1. Starts a test HTTP server on port 8080 with `/health` and `/restart` endpoints.
2. Creates an agent with the `httpMonitor` plugin configured to watch the test server.
3. Starts the Zup API on port 3000.
4. Runs the OODA loop every 5 seconds.
5. After 10 seconds, the test server's health endpoint begins returning 503.
6. After 3 consecutive failures (15 seconds), the agent detects the unhealthy state, decides to restart, and sends a POST to the restart endpoint.
7. The service recovers.

**Expected sequence:**

```
--- OODA Loop #1 ---
Status: HEALTHY - 200 (2ms)

--- OODA Loop #2 ---
Status: HEALTHY - 200 (1ms)

Making service unhealthy...

--- OODA Loop #3 ---
Status: UNHEALTHY - Service returned status 503 (failures: 1)

--- OODA Loop #4 ---
Status: UNHEALTHY - Service returned status 503 (failures: 2)

--- OODA Loop #5 ---
Status: UNHEALTHY - Service returned status 503 (failures: 3)
Decision: Endpoint test-service has 3 consecutive failures, attempting restart
Action: http-monitor:restartService

Service restart triggered (restart #1)
Success: Successfully restarted service for Test Service

--- OODA Loop #6 ---
Status: HEALTHY - 200 (1ms)
```

You can also interact with the monitoring API while it runs:

```bash
# Check monitored endpoints
curl http://localhost:3000/api/v0/http-monitor/endpoints \
  -H "Authorization: Bearer demo-key-123"

# Manually trigger a health check
curl -X POST http://localhost:3000/api/v0/http-monitor/endpoints/test-service/check \
  -H "Authorization: Bearer demo-key-123"

# Manually restart the service
curl -X POST http://localhost:3000/api/v0/http-monitor/endpoints/test-service/restart \
  -H "Authorization: Bearer demo-key-123"
```

This example is fully self-contained and needs no external services.

## llm-demo.ts -- LLM integration

**What it shows:** Using an LLM (Anthropic or OpenAI) inside an orienter to analyze observations and produce a situation assessment, including structured output with Zod validation.

**Prerequisites:**

Set one of these environment variables:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or
export OPENAI_API_KEY=sk-...
```

**Run:**

```bash
bun examples/llm-demo.ts
```

**What happens:**

1. Detects which LLM provider is available from environment variables.
2. Creates an agent with a custom plugin that registers two orienters:
   - **llm-situation-analysis** -- sends observations to the LLM as a free-text prompt and receives a natural language analysis.
   - **llm-structured-analysis** -- uses `generateStructured` with a Zod schema to get a typed analysis object with severity, contributing factor, symptoms, and recommended actions.
3. The plugin's observer returns synthetic metrics: high CPU (85%), normal memory (60%), and database connection timeouts.
4. Runs a single OODA loop and prints the LLM-generated assessments.

**Expected output (varies by LLM response):**

```
=== Zup LLM Integration Demo ===

Using anthropic (claude-3-5-sonnet-20241022)

Running OODA loop with LLM-powered analysis...

--- Results ---

Situation Assessment:

Source: llm-analysis/claude
Confidence: 0.9

  The system is experiencing elevated CPU usage at 85% (above 80% threshold)
  alongside database connection timeouts. Memory usage at 60% of 16GB appears
  normal. The database connection timeouts are likely contributing to the CPU
  spike as the application retries failed connections...

  Contributing Factor: Database connectivity issues causing cascading failures

Source: structured-analysis/claude
Confidence: 0.85

  Contributing factor: Database connection pool exhaustion
  Symptoms: High CPU usage, database connection timeouts, potential request queuing
  Recommended actions: Check database connection pool settings, restart database...

Demo complete!
```

The LLM demo makes real API calls. Each run costs a small amount of tokens (typically under 2000 total tokens per run).
