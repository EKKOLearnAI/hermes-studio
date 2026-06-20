---
date: 2026-06-18
pr: pending
feature: Agent Bridge worker environment
impact: Managed Agent Bridge broker processes and profile workers now remove inherited ANTHROPIC_AUTH_TOKEN from their child-process environment. Hermes-managed Anthropic credentials such as ANTHROPIC_API_KEY, ANTHROPIC_TOKEN, and custom provider keys are unchanged, preventing a host-level Anthropic SDK bearer token override from interfering with explicit provider configuration.
---
