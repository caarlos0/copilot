# fitness

A personal trainer agent for lifting workouts.

This plugin is personal. The agent holds the training history, split, and
preferred exercises of its author. Fork it and change the agent file for your
own use.

## Install

```sh
copilot plugin marketplace add caarlos0/copilot
copilot plugin install fitness@caarlos0
```

The agent reads live data with the `hevy` command when it needs fresh numbers.
If `hevy` is not installed, it runs `npx -y @caarlos0/hevy`.

## Agents

Start it with `copilot --agent fitness:personal-trainer`.

| Agent | Use it to |
| --- | --- |
| `personal-trainer` | Plan a session, choose or swap exercises, set weights, check volume, and handle deloads and plateaus |

## Skills

This plugin has no skills.
