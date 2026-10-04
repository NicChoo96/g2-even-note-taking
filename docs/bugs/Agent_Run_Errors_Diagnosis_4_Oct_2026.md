# Agent Run Errors — Diagnosis

4 Oct 2026. From the failed sessions in the agent queue.

- Duplicate jarvis_app slot — the runner's tool offer carries the same slot twice, and the collision is what kills the run before the prompt lands.
- Model string — the runner passes its own model instead of reading deepseek-flash off each agent, so agents run on the wrong model.