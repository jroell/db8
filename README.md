# db8

An adversarial reasoning arena. Two frontier coding agents (Claude Code and OpenAI Codex) debate any motion you give them, round by round, in front of a two-judge panel that scores every exchange and ends the debate only when both judges are convinced beyond persuasion.

Built for thought expansion, not spectacle: use it to stress-test a position before you defend it, to see the strongest version of both sides of a question, or to find the cruxes hiding under a disagreement.

## What makes it interesting

- **Everyone is blind.** Debaters are known only as PRO and CON, judges only as Judge 1 and Judge 2. No participant knows which model powers anyone, or that different models are involved at all. Engines are revealed to you only after the verdict.
- **Panel judging.** A Claude judge and a Codex judge deliberate independently every round, score logic, evidence, rebuttal, and persuasion, track the cruxes of the disagreement, and issue steering notes when the debate drifts. The debate ends when both are beyond persuasion or the round cap hits. Split decisions are a signal in themselves.
- **Substance over semantics.** Debaters are capped to short, forceful statements and instructed to argue the strongest reasonable reading of the motion. Judges are instructed to hard-cap scores for definitional lawyering and wording quibbles.
- **Evidence.** Paste file paths (PDF, images, code, whole directories) straight into the topic and both debaters read them. Web research is on by default and can be disabled per run or in settings. macOS clipboard images attach too.
- **Motion sharpening.** A fast pre-pass rewrites your raw topic into a single crisp, debatable claim before the debate starts.
- **Prep sheet.** Every debate exports a markdown report: full transcript with thinking summaries, round-by-round scorecards, the judges' final verdicts, best and worst arguments per side, steelmen of each side, and the attacks to prepare for if you defend either position yourself.

## Requirements

- [Bun](https://bun.sh) 1.3+
- The [Claude Code CLI](https://claude.com/claude-code) (`claude`), logged in
- The [OpenAI Codex CLI](https://github.com/openai/codex) (`codex`), logged in

## Install

```sh
git clone https://github.com/jroell/db8.git
cd db8
chmod +x debate.ts
ln -s "$PWD/debate.ts" ~/.local/bin/db8   # or anywhere on your PATH
```

Dependencies self-install next to the script on first run.

## Use

```sh
db8                                        # interactive: type a motion, watch the debate
db8 "Remote work is a net negative for junior engineers"
db8 --no-web --rounds 3 "P=NP"
db8 "Is this design sound? ~/docs/rfc.pdf ~/diagrams/arch.png"
db8 --fast "quick sparring session"        # cheap models, low effort, 3 rounds max
db8 config                                 # settings menu (models, efforts, judges, pausing)
DEBATE_MOCK=1 db8 --auto "ui dry run"      # zero-token demo of the whole pipeline
```

Debates run to completion hands-free by default. Turn on `Pause rounds` in `db8 config` (or pass `--pause`) to get a menu between rounds where you can interject a challenge, order a steelman round where each side argues the other position, or call for the verdict early.

Defaults (models, reasoning efforts, judge bench, web access, round cap, side assignment) live in `~/.config/db8/config.json` and are all editable through the `db8 config` menu. Every flag is a one-off override that leaves your saved settings untouched.

## Notes

- Transcripts are written to `transcripts/` next to the script and stay local (gitignored).
- Cost scales with your model and effort settings. `--fast` is cents per debate; heavyweight models at high effort with web research can be several dollars.
- Ctrl-C aborts the current turn; twice quits.
