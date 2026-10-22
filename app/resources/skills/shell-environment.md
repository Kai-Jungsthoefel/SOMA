---
title: Shell environment
name: Shell environment
summary: What to do when soma or pip is not found, soma says the shell lacks the app's environment, or umlauts in files look garbled.
order: 8
category: Way of working
default: on-demand
when: `soma` or `pip` is not found, `soma build` says the shell lacks the environment of the app's terminals, or umlauts in files look garbled (Ã¤, Ã¼)
topics: Why it happens; Running soma; Installing packages; Reading files in Windows PowerShell
---
# Skill: Shell environment

## Why it happens

The app's terminals put `soma`, `pip` and the model's own Python environment on the PATH. Some agents run their
commands somewhere else, for example in a background service that kept the environment of another program,
or in an agent app such as Claude Desktop or the Codex app that has this folder open. Then
`soma` is missing or another `pip` answers. The working folder is still the model's folder, so call everything
through the model's environment directly.

## Running soma

- Windows: `.soma\env\Scripts\python.exe -m soma build` (same for every other `soma` command).
- macOS and Linux: `.soma/env/bin/python -m soma build`.
- If that file is missing, tell the user. Do not create an environment yourself.
- `soma render` still works: it finds the running app on its own. If it reports that the app is not running, tell the
  user to open the model in SOMA.

## Installing packages

Only `.soma\env\Scripts\python.exe -m pip install <package>` (macOS and Linux: `.soma/env/bin/python -m pip install
<package>`). Never a `pip` or `python` from the PATH: the package would land outside the model, and `soma build` would
not find it or record it in `requirements.txt`.

## Reading files in Windows PowerShell

Windows PowerShell 5.1 reads files without a byte order mark as ANSI, so umlauts turn into `Ã¤`, `Ã¼`. The file is
fine, only the reading is wrong.

- Read with `Get-Content -Encoding UTF8 <file>`.
- Never copy garbled text into an edit: it would break the file.
- Do not write files with `Set-Content` or `Out-File` (ANSI or a byte order mark). Use your own file editing tool.
