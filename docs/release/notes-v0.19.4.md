# gh-glance v0.19.4

This patch release fixes checkouts with several git remotes and a paging stall in Issues and Pull requests.

- **Checkouts with several remotes.** A fork with an `upstream` remote, or any checkout whose remotes name more than one GitHub repository, now uses the default chosen with `gh repo set-default`, as `gh` does. Without a default, the dashboard names the repositories and asks you to run `gh repo set-default` or restart with `--repo owner/name`. Before, it showed "Repository unresolved" with a misleading connection or coordination failure, and it never recovered. A checkout with a single remote also follows an earlier `gh repo set-default` choice: if that choice names another repository, such as the parent of a fork, gh-glance now shows that repository.
- **A doctor that matches the dashboard.** `gh-glance --doctor` now reports the repository the dashboard will use and lists every git remote, marking the `gh` default. Before, it read only `origin`, so it could look healthy while the dashboard had no repository.
- **Reliable paging.** Scrolling near the end of Issues or Pull requests now loads the next page. When the scheduled request slot was a fraction of a millisecond away, the request was refused and the list stayed at its first page until you scrolled again. Other short waits, such as CI job logs, now also wait the remainder.

No shared quota, collector or cache protocol version changed, and dependency ranges are unchanged. Node.js 22 or newer remains required. Restart running panes after the upgrade. After you run `gh repo set-default` in a checkout that showed the new choice screen, restart gh-glance; it does not pick up the default while running.

Known limitations are those of v0.19.3: the GitHub status request uses Node's built-in `fetch`, which does not read `HTTPS_PROXY`, and `Events` history is per pane and in memory. Existing personal/work EMU and native assistive-technology qualification remain open or unmeasured.
