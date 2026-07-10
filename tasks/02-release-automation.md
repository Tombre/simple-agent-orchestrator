# Release Automation

## Objective

Continuously verify that the library, CLI, templates, and published package work in clean supported environments.

## Why

Local tests alone do not catch stale build output, broken package exports, missing template files, non-portable lockfiles, or installation failures. Automated release checks provide high reliability at low conceptual cost and protect the package's simple user experience.

## Goals

- Run tests, strict type checking, and builds on supported Node.js versions.
- Verify installation from the package artifact rather than only importing repository source.
- Exercise public package subpaths and the installed CLI.
- Initialize and validate a temporary consumer project from packaged templates.
- Check that required docs, skills, templates, declarations, and license files are included.
- Keep release failures actionable and reproducible locally.

## Scope Boundaries

- Do not introduce a complex release platform.
- Do not require broad infrastructure beyond conventional package CI.
- Coverage percentages are not a substitute for behavioral release checks.

## Completion Signals

- Every proposed release proves the package installs and runs in a clean consumer.
- Supported Node.js versions pass the same core contract.
- Published contents match documented exports and initialization behavior.
