## GitHub Actions Collection

This repository hosts multiple reusable composite GitHub Actions. Each action lives in its own directory at the repository root and exposes an `action.yml`.

### Available Actions
| Action | Path | Description |
|--------|------|-------------|
| Checkout Backlog Git Repository | `checkout-backlog` | Clone Backlog (Nulab) Git repo with optional shallow clone & tag fetch |

### Usage Pattern
```
uses: letrungdo/github-actions/<action-folder>@main
```
Example for Backlog checkout:
```
uses: letrungdo/github-actions/checkout-backlog@main
```

See detailed docs inside each action folder (`README.md`).


### Adding a New Action
1. Create folder: `your-action/`
2. Add `action.yml`
3. Add `README.md` with: purpose, inputs, outputs, example usage, version notes.
4. Update the table above.
5. Commit & push; retag if needed.

### Testing Locally in Another Repo
Reference via relative path before publishing:
```
uses: ./path/to/cloned/github-actions/checkout-backlog
```

### License
MIT (see LICENSE)

---
Made with ❤️ – contributions welcome.

