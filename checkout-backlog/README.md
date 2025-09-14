## Checkout Backlog Git Repository (Minimal)

Minimal SSH-only variant: you provide the exact repository SSH URL; the action clones it and cleans up the ephemeral key file.

### Inputs
| Name | Required | Description |
|------|----------|-------------|
| `repo-url` | ✅ | Full SSH URL, e.g. `user@space.git.backlog.com:/PROJECT_KEY/repo.git` |
| `ssh-private-key` | ✅ | Private SSH key (OpenSSH / PEM) matching a read-access key on Backlog |
| `branch` | ❌ | Branch name (single branch checkout) |
| `depth` | ❌ | Shallow clone depth (omit for full history) |
| `dest` | ❌ | Destination directory (default `backlog-repo`; use `.` only if workspace empty) |

### Outputs
| Name | Description |
|------|-------------|
| `repo-path` | Path used for clone (same as `dest`) |
| `commit-sha` | HEAD commit SHA after clone |

### Example
```yaml
jobs:
  clone:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Backlog repo
        uses: letrungdo/github-actions/checkout-backlog@main
        with:
          repo-url: space@space.git.backlog.com:/PROJECT_KEY/repo.git
          ssh-private-key: ${{ secrets.BACKLOG_SSH_KEY }}
          branch: main
          depth: 1
          dest: app
```

### Behavior
- Writes key to `~/.ssh/id_backlog_<uuid>` (0600).
- Populates `known_hosts` with `ssh-keyscan` best-effort (non-fatal if it fails).
- Uses `GIT_SSH_COMMAND="ssh -i <keyfile> -o StrictHostKeyChecking=accept-new"` so no global `ssh-agent` state is shared across parallel jobs.
- `accept-new` avoids TOCTOU races while still pinning the host on first use; subsequent mismatches will fail.
- Post step deletes the ephemeral key file via saved state.

### Migration Note
All previous discovery inputs (`space`, `project-key`, `repo`, `ssh-url`, etc.) removed. Supply the exact working `repo-url` now. Retrieve the earlier, more feature-rich version from history if you still need host/URL guessing.

### Troubleshooting
| Issue | Cause | Fix |
|-------|-------|-----|
| Timeout / connect fail | Wrong host in `repo-url` | Confirm `<space>.git.backlog.com` vs `<space>.backlog.com` |
| Permission denied (publickey) | Key not registered | Upload matching public key to Backlog repo settings |
| Unknown host key | First-time host; keyscan failed | Re-run; or manually add known_hosts; verify DNS |
| No STATE_ vars in post | Runner quirk | Fallback deletion already handles cleanup |

### Security
Use a read-only deploy key if possible. Revoke keys not in use. The key file is ephemeral and removed post job.

---
MIT License.
