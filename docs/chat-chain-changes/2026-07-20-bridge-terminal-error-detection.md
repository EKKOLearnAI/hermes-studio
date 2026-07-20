---
date: 2026-07-20
commit: pending
feature: Bridge terminal error false-positive prevention
impact: Successful long-form assistant responses can discuss rate limiting and other failure concepts without being emitted as transient run.failed messages.
---

# Bridge terminal error detection avoids long-form false positives

- Trust an explicit successful bridge result instead of reclassifying its final response from incidental error terminology.
- Keep compact final-response detection for providers that return API failures without setting bridge failure flags.
- Narrow Chinese rate-limit matching so normal documentation such as `初始化登录限流` remains a successful assistant response.
- Cover successful documentation, genuine Chinese rate-limit failures, and long-form responses with terminal-error regression tests.
