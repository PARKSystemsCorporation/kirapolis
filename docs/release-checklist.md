# Release Checklist

## Before Push

- Confirm `.env`, local databases, caches, backups, and runtime state are not staged.
- Run `npm run build`.
- Run `npm run typecheck`.
- Review `git diff --stat` for unexpected assets or generated noise.
- Check branding and repo links for consistency with `Kirapolis`.

## Privacy

- Search for absolute local paths.
- Search for usernames, emails, tokens, and private keys.
- Verify starter state files do not contain live operational history.
- Confirm only intentional public attribution remains in the repository.

## Public Repo Readiness

- Update `README.md` if startup steps changed.
- Verify `.env.example` still matches the code paths in use.
- Confirm `.gitattributes` still marks generated output correctly.
- Confirm `LICENSE` remains Apache-2.0 and any new docs match the open-source posture.
- Sanity-check package names, repo URL, and visible product naming.

## Optional

- Add CI, issue templates, or contribution docs if outside collaborators are expected.
