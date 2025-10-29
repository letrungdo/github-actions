import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";

async function run() {
  try {
    // Simplified v2 inputs
    const repoUrl = core.getInput("repo-url", { required: true }).trim();
    const sshPrivateKey = core.getInput("ssh-private-key", { required: true });
    const branch = core.getInput("branch");
    const depth = core.getInput("depth");
    const dest = core.getInput("dest") || "backlog-repo";
    const forceClean = core.getInput("force-clean") === "true";

    core.info(
      `[checkout-backlog] Inputs: branch="${branch}", dest="${dest}", force-clean=${forceClean}, depth="${depth}"`
    );

    // Save raw dest input early for post cleanup logic
    core.saveState("clone-dest-input", dest);

    if (!repoUrl.match(/^[^@:]+@[^:]+:.+\.git$/)) {
      core.warning(
        "repo-url does not appear to be a canonical SSH style (user@host:project/repo.git). Ensure it is correct."
      );
    }

    // Pre-clone validation / cleanup logic
    async function pathExists(p: string) {
      try {
        await fs.stat(p);
        return true;
      } catch {
        return false;
      }
    }

    if (dest === ".") {
      const cwd = process.cwd();
      const entries = (
        await fs.readdir(cwd, { withFileTypes: true }).catch(() => [])
      ).filter((n) => ![".", ".."].includes(n.name));

      // Check if .git directory exists (hidden files)
      const gitExists = await pathExists(path.join(cwd, ".git"));

      if (entries.length > 0 || gitExists) {
        if (forceClean) {
          core.warning(
            "[checkout-backlog] force-clean=true and dest='.'; deleting ALL existing workspace entries (including .git) before clone."
          );

          // First, remove .git directory explicitly to ensure clean state
          if (gitExists) {
            try {
              core.info("[checkout-backlog] Removing existing .git directory");
              await fs.rm(path.join(cwd, ".git"), {
                recursive: true,
                force: true,
              });
            } catch (e: any) {
              core.warning(
                `[checkout-backlog] Failed to remove .git directory: ${e.message}`
              );
            }
          }

          // Then remove all other entries
          for (const entry of entries) {
            try {
              await fs.rm(path.join(cwd, entry.name), {
                recursive: true,
                force: true,
              });
            } catch (e: any) {
              core.warning(
                `[checkout-backlog] Failed to remove workspace entry ${entry.name}: ${e.message}`
              );
            }
          }
        } else {
          throw new Error(
            "dest='.' but workspace is not empty. Choose a different dest or set force-clean=true (DANGEROUS)."
          );
        }
      } else {
        core.info(
          "[checkout-backlog] Workspace is empty; proceeding with dest='.'"
        );
      }
    } else {
      if (await pathExists(dest)) {
        // If directory exists, check if empty
        let existing: string[] = [];
        try {
          existing = await fs.readdir(dest);
        } catch (e: any) {
          core.warning(
            `[checkout-backlog] Could not read existing destination directory '${dest}': ${e.message}`
          );
        }
        if (existing.length > 0) {
          if (forceClean) {
            core.warning(
              `[checkout-backlog] force-clean=true; removing existing directory '${dest}' before cloning.`
            );
            try {
              await fs.rm(dest, { recursive: true, force: true });
            } catch (e: any) {
              throw new Error(
                `Failed to remove existing destination directory '${dest}': ${e.message}`
              );
            }
          } else {
            throw new Error(
              `Destination '${dest}' already exists and is not empty. Choose a different dest or enable force-clean.`
            );
          }
        } else {
          core.info(
            `[checkout-backlog] Destination directory '${dest}' exists but is empty; proceeding.`
          );
        }
      }
    }
    const cloneUrl = repoUrl;

    // Unique key file per job to avoid collisions in parallel matrix builds.
    const keyId = randomUUID();
    const sshDir = path.join(process.env.HOME || "~", ".ssh");
    const keyFile = path.join(sshDir, `id_backlog_${keyId}`);

    await fs.mkdir(sshDir, { recursive: true });
    // Normalize private key:
    // - Convert Windows CRLF to LF
    // - If the secret was pasted with literal \n sequences, convert them to newlines (heuristic: contains BEGIN and END lines but no real newlines or has \n)
    // - Ensure a trailing newline (ssh requires it for some key parsers)
    let normalizedKey = sshPrivateKey.replace(/\r\n?/g, "\n");
    if (normalizedKey.includes("-----BEGIN") && normalizedKey.includes("\\n")) {
      // Convert escaped newlines only if actual newlines seem sparse compared to escapes
      const realLineCount = normalizedKey.split("\n").length;
      const escapedCount = (normalizedKey.match(/\\n/g) || []).length;
      if (escapedCount > realLineCount) {
        normalizedKey = normalizedKey.replace(/\\n/g, "\n");
      }
    }
    if (!/\n$/.test(normalizedKey.trimEnd())) {
      normalizedKey = normalizedKey.trimEnd() + "\n";
    }
    await fs.writeFile(keyFile, normalizedKey, { mode: 0o600 });
    // Save state for post-job cleanup AS EARLY AS POSSIBLE.
    // If any later step fails (e.g., git clone), we still want the post action
    // to know which ephemeral key file to remove.
    core.saveState("ssh-key-file", keyFile);
    // Ensure known_hosts contains a single (deduped) set of keys for the target host.
    const hostMatch = cloneUrl.match(/^[^@]+@([^:]+):/);
    const host = hostMatch ? hostMatch[1] : "";
    const knownHostsPath = path.join(sshDir, "known_hosts");

    async function ensureKnownHosts(targetHost: string) {
      if (!targetHost) return;
      try {
        await fs.mkdir(sshDir, { recursive: true });
        let existing = "";
        try {
          existing = await fs.readFile(knownHostsPath, "utf8");
        } catch {
          /* ignore */
        }
        const lines = existing
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0);

        // Build a quick map of keytype => present
        const presentKeyTypes = new Set<string>();
        for (const l of lines) {
          // Format: hostnames keytype keydata [comment]
          const parts = l.split(/\s+/);
          if (parts.length >= 3) {
            const hostField = parts[0];
            if (hostField.split(",").includes(targetHost)) {
              presentKeyTypes.add(parts[1]);
            }
          }
        }
        const desiredTypes = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"]; // include rsa for older setups
        const missingTypes = desiredTypes.filter(
          (t) => !presentKeyTypes.has(t)
        );

        if (missingTypes.length > 0) {
          // Only scan missing types to avoid duplicate lines.
          const typeArg = missingTypes.join(",");
          let scanOutput = "";
          await exec.exec(
            "bash",
            [
              "-c",
              `ssh-keyscan -T 15 -t ${typeArg} ${targetHost} 2>/dev/null || true`,
            ],
            {
              listeners: {
                stdout: (data: Buffer) => (scanOutput += data.toString()),
              },
            }
          );
          if (scanOutput.trim()) {
            const newLines = scanOutput
              .split(/\r?\n/)
              .filter((l) => l.trim().length > 0);
            for (const nl of newLines) {
              lines.push(nl.trim());
            }
          }
        }

        // Dedupe preserving first occurrence using a hash of the full line (ignore whitespace diffs)
        const seen = new Set<string>();
        const deduped: string[] = [];
        for (const l of lines) {
          const norm = createHash("sha256")
            .update(l.replace(/\s+/g, " "))
            .digest("hex");
          if (!seen.has(norm)) {
            seen.add(norm);
            deduped.push(l);
          }
        }
        await fs.writeFile(knownHostsPath, deduped.join("\n") + "\n", {
          mode: 0o600,
        });
      } catch (e: any) {
        core.warning(
          `[checkout-backlog] ensureKnownHosts failed: ${e.message}`
        );
      }
    }

    await ensureKnownHosts(host);

    // Use GIT_SSH_COMMAND with direct identity file & accept-new to avoid ssh-agent global state
    const gitSshCommand = `ssh -i ${keyFile} -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHostsPath}`;
    core.exportVariable("GIT_SSH_COMMAND", gitSshCommand);
    core.info(`[checkout-backlog] Using ephemeral SSH key file ${keyFile}`);

    // Configure git to use SSH instead of HTTPS for Backlog
    // This allows flutter pub get and other git operations to work with private repos
    if (host) {
      try {
        // Extract SSH prefix: guide@guide.git.backlog.com:
        const sshMatch = cloneUrl.match(/^([^@]+@[^:]+:)/);
        if (!sshMatch) {
          throw new Error("Could not extract SSH prefix from repo-url");
        }
        const sshPrefix = sshMatch[1];

        // Convert guide.git.backlog.com -> guide.backlog.com for HTTPS
        // Some Backlog instances use .git. subdomain for SSH but not for HTTPS
        const httpsHost = host.replace(/\.git\./, ".");
        const httpsPrefix = `https://${httpsHost}/git/`;

        core.info(
          `[checkout-backlog] Configuring git URL rewriting: ${httpsPrefix} -> ${sshPrefix}`
        );

        await exec.exec("git", [
          "config",
          "--global",
          `url.${sshPrefix}.insteadOf`,
          httpsPrefix,
        ]);
      } catch (e: any) {
        core.warning(
          `[checkout-backlog] Failed to configure git insteadOf: ${e.message}`
        );
      }
    }

    // No pre-clone cleanup (workspace may retain previous artifacts until post step wipes it)
    const cloneArgs = ["clone"];
    if (depth) cloneArgs.push("--depth", depth);
    if (branch) cloneArgs.push("--branch", branch, "--single-branch");
    cloneArgs.push(cloneUrl, dest);
    const cloneMsg = branch
      ? `Cloning ${cloneUrl.replace(/:.*/, ":***")} (branch: ${branch})`
      : `Cloning ${cloneUrl.replace(/:.*/, ":***")}`;
    core.info(`[checkout-backlog] ${cloneMsg}`);
    await exec.exec("git", cloneArgs);

    // Outputs
    const absoluteDest =
      dest === "." ? process.cwd() : path.join(process.cwd(), dest);

    // Use --local instead of --global to avoid polluting runner's global .gitconfig
    await exec
      .exec("git", [
        "config",
        "--local",
        "--add",
        "safe.directory",
        path.join(process.cwd(), dest),
      ], {
        cwd: absoluteDest,
      })
      .catch(() => {});
    core.setOutput("repo-path", dest);
    core.saveState("clone-dest-path", absoluteDest);

    // Log current branch name
    try {
      let branchName = "";
      await exec.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: absoluteDest,
        listeners: {
          stdout: (data: any) => {
            branchName += data.toString();
          },
        },
      });
      branchName = branchName.trim();
      if (branchName) {
        core.setOutput("branch-name", branchName);
      }
    } catch (e: any) {
      core.warning(`Could not determine branch name: ${e.message}`);
    }

    try {
      let sha = "";
      await exec.exec("git", ["rev-parse", "HEAD"], {
        cwd: absoluteDest,
        listeners: {
          stdout: (data: any) => {
            sha += data.toString();
          },
        },
      });
      sha = sha.trim();
      if (sha) {
        core.setOutput("commit-sha", sha);
      }
    } catch {
      core.warning("Could not determine commit SHA");
    }
    core.info(`[checkout-backlog] Clone completed into ${dest}`);
  } catch (err: any) {
    core.setFailed(err.message || String(err));
  }
}

run();
