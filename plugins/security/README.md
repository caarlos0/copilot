# security

Agents for secure design, vulnerability hunting, and security report triage.

## Install

```sh
copilot plugin marketplace add caarlos0/copilot
copilot plugin install security@caarlos0
```

Install the `coding` plugin too. The security agents use its skills for language
conventions and reviews.

## Agents

Start one with `copilot --agent security:<name>`.

| Agent | Use it to |
| --- | --- |
| `engineer` | Threat model a feature, fix a vulnerability at its root cause, and harden builds, CI, and the supply chain |
| `researcher` | Check a security report or CVE against the current code, measure real exposure, and plan disclosure |
| `vuln-hunter` | Audit code in read-only mode. It reports only findings that it reproduced |

## Skills

This plugin has no skills.
