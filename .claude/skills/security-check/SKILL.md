---
description: Use when performing security assessments, reviewing or writing a security fix, checking CI/CD for injection, scanning dependencies, and compliance checks.
---

# Security Check

The project's absolute rules live in `.claude/rules/05-security.md` and the root CLAUDE.md «Never» list (refresh token only in an httpOnly cookie, no JWT in URLs, HMAC compared with `timingSafeEqual`, upload policy on every file endpoint, MCP keys stored hashed). This skill adds the review method.

## Before the fix: inventory the sinks

- A report names one instance of a vulnerability class. Before fixing it, grep every sink of the same class — every renderer of model output, every writer of the shared JSON column, every path that issues a token, every route behind the same guard — and state in the PR which sinks the fix covers and which are out of scope.

## Specific classes

- **Challenge controls** (captcha, anti-bot): the payload sent to the client must not contain the structure the challenge is meant to hide (vector paths, glyph ids, DOM text) — ship pixels. Any visual simplification of such a control is a security change and goes through this review.
- **CI/CD logs are interpreters, not sinks.** Untrusted text printed into a GitHub Actions log is wrapped in `::stop-commands::<random token>` … `::<token>::`; the markers, the untrusted text and any later annotations go to the same stream; untrusted values are never interpolated into workflow expressions.
- **Secrets in output:** never print a line that may contain a secret, even through a redaction filter you have not tested. Check presence or position with a script that prints only booleans, counts or hashes.
