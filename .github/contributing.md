# 📛 PDFtoIMG-JS Contributing Guide

Hi there! 👋 We're thrilled that you're considering contributing to **PDFtoIMG-JS**.  
Before you start, please read through the following guidelines to help keep the project clean, organized, and welcoming:

- [Pull Request Guidelines](#pull-request-guidelines)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)

---

## ✅ Pull Request Guidelines

- **Branching:**

  - Always create a feature/fix branch from `main` (example: `feature/add-scale-option`, `fix/pdf-load-issue`).
  - Open pull requests against the `main` branch.

- **If adding a new feature:**

  - Please open an issue first to discuss it, unless it's very small.
  - Provide a clear explanation of what the feature does and why it's needed.

- **If fixing a bug:**

  - Explain the bug in the PR description.
  - Provide a test case or reproducible example if possible (e.g., a file in `/example`).

- **Commits:**

  - It's fine to have multiple small commits; GitHub will allow squashing before merging.
  - Write meaningful commit messages:
    - Use the **imperative mood** (e.g., `Fix broken PDF loading` instead of `Fixed broken PDF loading`).
    - Reference related issues: (`Fixes #42`, `Closes #56`).

- **Code Style:**

  - Use the existing ESLint and Prettier rules.
  - Before submitting, run:
    ```bash
    pnpm lint
    pnpm format
    ```

- **Testing:**
  - Make sure your changes pass existing tests.
  - If needed, add new tests in the `tests/` directory (Vitest).

---

## 🛠 Development Setup

Ensure you have [Node.js](https://nodejs.org/) 22.13 or newer and [pnpm](https://pnpm.io) installed globally.

Clone the repository and install dependencies:

```bash
$ git clone https://github.com/tysonjf/pdftoimg-js.git
$ cd pdftoimg-js
$ pnpm install
```

---

### Useful Commands

| Command          | Purpose                                                         |
| :--------------- | :-------------------------------------------------------------- |
| `pnpm build`     | Build production-ready files into `dist/`.                      |
| `pnpm typecheck` | Type-check `src/` and `tests/` without emitting.                |
| `pnpm lint`      | Lint the source code.                                           |
| `pnpm format`    | Format source code with Prettier.                               |
| `pnpm test`      | Run the Vitest suite, including the Convex-style bundling test. |
| `pnpm example`   | Run an example script located in `/example/example.ts`.         |

---

## 📁 Project Structure

```
/dist            # Built output
/example         # Example usage and sample PDFs
/src
  browser.ts     # Browser entrypoint (HTML5 canvas)
  cli.ts         # CLI entrypoint
  index.ts       # Node entrypoint
  pdfjs-node.ts  # Loads pdf.js for Node: worker registration, asset paths
  prompts.ts     # CLI prompts
  types.ts       # Shared TypeScript types
  utils.ts       # Utility functions
  validators.ts  # Validators for CLI options
/tests           # Vitest suite and fixtures
.gitignore
.prettierrc
eslint.config.mjs
LICENSE
package.json
pnpm-lock.yaml
readme.md
tsconfig.json
tsup.config.ts
vitest.config.mts
```

---

## 🙌 Thank You!

Thanks again for your interest and efforts to improve **PDFtoIMG-JS**!  
Every contribution, no matter how small, helps make the project better for everyone 🚀

If you have any questions, feel free to open an [issue](https://github.com/iqbal-rashed/pdftoimg-js/issues) or [discussion](https://github.com/pdftoimg-js/discussions).

---

# 📜 License

MIT
