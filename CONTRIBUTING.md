# Contributing

Thanks for your interest in SOMA. Bug reports, ideas and pull requests are welcome. SOMA is maintained by one person in
their spare time, so please expect a few days until an answer.

## Issues

- **Bug reports:** what happened, the steps to get there, and the system info from Settings > About > "Copy system info".
- **Ideas:** describe what you were trying to design and what got in the way. A real example helps more than a feature
  list.
- **Experience with agents:** which agent and model you used, and where it struggled with CadQuery or the skills.

Please use the [issue templates](https://github.com/Kai-Jungsthoefel/SOMA/issues/new/choose). Security problems go
through private reporting, see [SECURITY.md](SECURITY.md).

## Pull requests

- **Small fixes** (bugs, typos, docs): open a pull request directly.
- **Anything bigger** (a new feature, changes to the `.soma` format, the `soma` API or command line, the agent
  instructions or the skills): open an issue first and describe what you want to change. This avoids work that cannot be
  merged.
- One topic per pull request. Issues labeled
  [good first issue](https://github.com/Kai-Jungsthoefel/SOMA/labels/good%20first%20issue) are a good place to start.

### Development setup

Structure, commands and code principles are in [CLAUDE.md](CLAUDE.md), the instructions for agents working on SOMA.
They apply to people as well.

```
# once: Python environment with soma and CalculiX
powershell -File python/scripts/setup_env.ps1

# in app/
npm install
npm start
```

Development is set up and tested on Windows. On macOS and Linux it may need adjustments. If you get it running there, a
pull request that documents the steps is very welcome.

### Before you open a pull request

- `npm run typecheck` and `npm test` pass (in `app/`). If you changed animations, analysis, FEM or the render window,
  also run `node test/run-all.mjs animation fem` after `npm run build`.
- Anything users notice gets a short entry under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).
- For interface changes, add a screenshot to the pull request.
- Say which system you tested on.

### Language

SOMA is written in English: interface, messages, `soma` output, skills, docs, code comments and commit messages. Older
code still has comments in German, you don't need to translate them.

References like `(E12)` in the code point to the maintainer's decision log, which is not public. You can ignore them.

### Coding agents

Using a coding agent is fine, most of SOMA was written with Claude Code. [CLAUDE.md](CLAUDE.md) gives your agent the
context it needs. You are responsible for the change: read it, run the tests, and be able to explain it.

## License of contributions

SOMA is licensed under the GPL, version 3 or any later version, with the [SOMA Model Exception](MODEL-EXCEPTION.md). The
exception makes sure that what people design with SOMA belongs to them.

By opening a pull request, you agree that your contribution is licensed under the same terms, including the Model
Exception. Contributions to `python/soma/cqruntime.py` and `python/soma/fasteners.py` are also licensed under the Apache
License 2.0, like these files.

You are also free to fork SOMA under the terms of the [GPL](LICENSE).
