# Security

## Reporting a vulnerability

Please do not report security problems in public issues. Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/Kai-Jungsthoefel/SOMA/security/advisories/new) (tab "Security" > "Report a vulnerability").

Please include the SOMA version (Settings > About > "Copy system info"), your system, and the steps or the file that
trigger the problem. SOMA is maintained by one person in their spare time. You can expect a first answer within about two
weeks. Fixes go into a new release, and the advisory is published once the fix is out.

## Supported versions

Only the latest release gets fixes. SOMA is at 0.x, there are no maintenance branches.

## What SOMA does by design

SOMA runs code. A few things are intended behavior, not vulnerabilities:

- **A model is Python code, and SOMA runs it.** `model.py`, `parts/`, animations, analyses and drawings run with your
  user rights whenever SOMA builds them, and building starts on its own once you work with a model. Only open `.soma` or ZIP files from people you trust, just like you would
  only run their scripts.
- **The agent runs in a normal terminal.** SOMA starts the CLI agent you chose in the model folder. What it may do is
  decided by the agent and its permission settings, not by SOMA.
- **Packages a model asks for are installed from PyPI.** Before building, SOMA installs what a model's
  `requirements.txt` lists into a separate environment for that model. This is part of running the model's code.
- **The packages are not signed yet.** Download them only from the
  [releases page](https://github.com/Kai-Jungsthoefel/SOMA/releases) of this repository.

What we do want to hear about, for example:

- Opening a model or ZIP file that writes or reads files outside its own folder without running its Python code
  (for example through path traversal in the archive or the project files)
- Model content (file names, part names, Markdown, skills, PDFs) that runs script in the app window
- Ways for a model or an agent to reach the app's internals beyond the documented `soma` command line
- Problems in how the installers or the release workflow are built
