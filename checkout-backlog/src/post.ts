import * as core from "@actions/core";
import * as fs from "fs/promises";
import * as path from "path";

async function runPost() {
  try {
    const keyFile = core.getState("ssh-key-file");
    const destInput = core.getState("clone-dest-input");
    const destPath = core.getState("clone-dest-path");

    // Remove ephemeral SSH key file
    if (keyFile) {
      try {
        await fs.rm(keyFile, { force: true });
        core.info(`[checkout-backlog][post] Removed SSH key file: ${keyFile}`);
      } catch (e) {
        core.warning(
          `[checkout-backlog][post] Failed to remove key file: ${keyFile} (${
            (e as Error).message
          })`
        );
      }
    }

    // Aggressive repository cleanup (user requested full wipe)
    try {
      if (destInput) {
        if (destInput === ".") {
          const cwd = process.cwd();
          const entries = await fs.readdir(cwd).catch(() => [] as string[]);
          for (const name of entries) {
            if (name === "." || name === "..") continue;
            await fs
              .rm(path.join(cwd, name), { recursive: true, force: true })
              .catch(() => {});
          }
          core.info("[checkout-backlog][post] Removed all workspace contents");
        } else if (destPath) {
          await fs.rm(destPath, { recursive: true, force: true });
          core.info(
            `[checkout-backlog][post] Removed cloned repository directory: ${destPath}`
          );
        }
      }
    } catch (e) {
      core.warning(
        `[checkout-backlog][post] Failed to cleanup repository (${
          (e as Error).message
        })`
      );
    }
  } catch (err: any) {
    core.warning(`Post cleanup failed: ${err.message || String(err)}`);
  }
}

runPost();
