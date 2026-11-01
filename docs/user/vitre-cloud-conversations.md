# Local and cloud conversations in Vitre

Use the location popup beside reasoning in the input container to choose **Local**, **Cloud: GitHub**, or
**Cloud: Local**. The conversation stays in the same sidebar entry, timeline and
composer. New conversations default to Local; cloud provisioning begins when you
send the first message.

Cloud: GitHub infers the repository and branch and carries unpublished work
without pushing. Public repositories clone anonymously and do not require a GitHub App installation. Private repositories still require connected access. The workspace carries your configured Git commit name and email; pushing or publishing still requires separate write access. Cloud: Local uploads the workspace and additional folders,
including projects that do not use Git. Connect your cloud and AI accounts when
required. Your provider, model, settings, history and attachments travel with you.

Changing location during a turn queues the move until that turn and any pending
approvals finish. Progress appears in the selector. You can edit your draft while
waiting and cancel before ownership transfers. Errors use the existing notices.

On return, Vitre combines cloud changes with independent local edits in a managed
workspace. If changes conflict, the cloud retains ownership. Resolve them in the
existing editor using the selector's conflict actions, then retry. The original
local folder remains intact.

Files, search, editing, Git, terminals and browser previews use the active
workspace. Cloud work continues when the desktop disconnects. Idle workers stay
available briefly and reopen from checkpoints when needed. Terminal output and
working directories survive moves; app-launched commands can restart, while
manually typed commands are never replayed automatically.

Use the usual composer for follow-ups, Stop, approvals and questions. Rename,
archive and delete remain in the conversation menu. Settings → Cloud manages
accounts and limits; usage separates money **used** from money **held** for active
work.

Use **Manage GitHub accounts** in Cloud settings to connect repository accounts.
Choose **Connect GitHub account**, enter the displayed code on GitHub, select the
account, and review its permissions. Keep the Vitre page open until it confirms
the connection. Private repositories also need the Vitre GitHub App installed.
Sign in to the same Vitre account on desktop and mobile to use these connections;
connecting another repository account does not add a new Vitre sign-in method.

Cloud sign-in is persisted and shared across desktop windows and subprocesses.
Project data stays separate. Selecting a location updates immediately while the
move runs; failed moves restore the previous selection.

Uploads exclude installed dependencies (including `node_modules`), generated
caches, and credential files. Git ignore rules and `.vitreignore` can exclude
additional files. Small files share content-addressed chunks; transfers run in
parallel and reuse verified chunks instead of uploading unchanged bytes again.

On the cloud machine, Vitre detects npm, pnpm, or Yarn from the project files and
installs dependencies using the available lockfile. A persistent package cache
reduces repeated downloads. Installation failures appear as setup warnings; the
conversation remains usable so you can fix the project configuration. Installed
dependencies are not copied back to your computer.
